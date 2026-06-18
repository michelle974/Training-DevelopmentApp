// api/auth.js
// Username/PIN auth + self-signup. Four roles:
//   admin    — spans ALL coaches and ALL athletes; build-capable everywhere
//   coach    — a practitioner; sees only athletes whose coachId matches them
//   parent   — a guardian; sees only the athletes listed for them
//   athlete  — an individual rider; sees only themselves
//
// Roster sources (merged; env wins on id collision):
//   CLIENT_ROSTER       env-var JSON array of athletes (legacy, hand-edited)
//   ROSTER_PROJECT_ID   Asana project whose tasks each hold one athlete record
//                       (written at runtime by self-signup)
//
// Env vars:
//   ASANA_TOKEN        Asana PAT from the dedicated RACE READY account/workspace.
//   ADMIN             JSON object {email,pin,name} OR array of them. Top tier.
//   PRACTITIONER      JSON object OR array. Each coach:
//     { "id":"michelle", "email":"...", "pin":"...", "name":"Michelle",
//       "libraryProjectId":"12..." }   // where this coach's library lives
//   CLIENT_ROSTER     JSON array of athlete objects. Each athlete:
//     {
//       "id":"gavin", "name":"Gavin M.",
//       "coachId":"michelle",          // which coach owns this athlete
//       "planProjectId":"12...", "logProjectId":"12...", "metaProjectId":"12...",
//       "athleteLogin": { "email":"gavin", "pin":"1234" },   // optional
//       "parents": [ { "email":"michelle", "pin":"0000" } ]  // optional
//     }
//   SIGNUP_CODES      JSON array mapping codes to coaches:
//     [ { "code":"GAVIN24", "coachId":"michelle", "role":"athlete" },
//       { "code":"PARENT24","coachId":"michelle", "role":"parent" } ]
//
// The library a viewer sees is keyed to the ATHLETE's coach, not to the logged-in
// user. So an admin viewing a Sarasota athlete transparently gets the Sarasota
// library; a coach only ever sees their own athletes and their own library.

const A = require('./_asana');

const ROSTER_TASK_PREFIX = 'Athlete ';   // roster task name = "Athlete <id>"

function parseJSONEnv(name, fallback) {
  try { return JSON.parse(process.env[name] || fallback); }
  catch (e) { return JSON.parse(fallback); }
}
function asArray(raw) { return Array.isArray(raw) ? raw : [raw]; }
function lc(s) { return (s || '').toLowerCase().trim(); }

// ── coaches & library resolution ────────────────────────────────────────────
function loadCoaches() {
  return asArray(parseJSONEnv('PRACTITIONER', '{}')).filter(function (p) { return p && p.email; });
}
function coachById(coaches, id) {
  if (!id) return null;
  return coaches.find(function (c) { return c.id && c.id === id; }) || null;
}
// libraryProjectId for an athlete: its coach's library, else null (frontend
// falls back to the athlete's own metaProjectId).
function libraryFor(athlete, coaches) {
  const c = coachById(coaches, athlete.coachId);
  return (c && c.libraryProjectId) || null;
}

// ── roster: env + Asana project, merged (env wins on id) ─────────────────────
async function loadRoster() {
  const envRoster = parseJSONEnv('CLIENT_ROSTER', '[]');
  const byId = {};
  // project roster first, env second so env overwrites on collision
  const projectId = process.env.ROSTER_PROJECT_ID;
  if (projectId) {
    try {
      const tasks = await A.listProjectTasks(projectId);
      tasks.forEach(function (t) {
        const rec = A.decodeRecord(t.notes);
        const athlete = rec.Athlete;   // whole record stored as one JSON field
        if (athlete && athlete.id) { athlete._rosterTaskGid = t.gid; byId[athlete.id] = athlete; }
      });
    } catch (e) { /* project unreadable → degrade to env-only roster */ }
  }
  envRoster.forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  return Object.keys(byId).map(function (k) { return byId[k]; });
}

// write (create or update) one athlete record as a roster task
async function upsertRosterAthlete(athlete) {
  const projectId = process.env.ROSTER_PROJECT_ID;
  if (!projectId) throw new Error('ROSTER_PROJECT_ID not set — cannot persist signup');
  const name = ROSTER_TASK_PREFIX + athlete.id;
  const notes = A.encodeRecord({ Athlete: athlete });
  if (athlete._rosterTaskGid) {
    await A.updateTask(athlete._rosterTaskGid, { name: name, notes: notes });
    return athlete._rosterTaskGid;
  }
  const t = await A.getOrCreateSingleton(projectId, name, notes);
  // getOrCreateSingleton returns existing untouched; ensure notes are current
  await A.updateTask(t.gid, { notes: notes });
  return t.gid;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const coaches = loadCoaches();

    // public-safe view of one athlete (no PINs leak); stamps the coach's library
    const pub = function (a) {
      return {
        id: a.id,
        name: a.name,
        planProjectId: a.planProjectId || null,
        logProjectId: a.logProjectId || null,
        metaProjectId: a.metaProjectId || null,
        libraryProjectId: libraryFor(a, coaches)
      };
    };

    // ════ SIGNUP ════════════════════════════════════════════════════════════
    if (body.action === 'signup') {
      const code = (body.code || '').trim();
      const email = lc(body.email);
      const pin = (body.pin || '').trim();
      const name = (body.name || '').trim();
      if (!code || !email || !pin || !name) {
        res.status(400).json({ error: 'Code, username, PIN, and name are all required.' }); return;
      }

      const codes = parseJSONEnv('SIGNUP_CODES', '[]');
      const match = codes.find(function (c) { return c.code === code; });
      if (!match) { res.status(401).json({ error: 'That signup code is not valid.' }); return; }
      const coach = coachById(coaches, match.coachId);
      if (!coach) { res.status(500).json({ error: 'Signup code is misconfigured (unknown coach).' }); return; }

      const roster = await loadRoster();

      // ── parent signup: attach to an existing athlete ──────────────────────
      if (match.role === 'parent') {
        const athleteId = (body.athleteId || '').trim();
        if (!athleteId) { res.status(400).json({ error: 'Parent signup needs the athlete to link to.' }); return; }
        const target = roster.find(function (a) { return a.id === athleteId; });
        if (!target) { res.status(404).json({ error: 'No athlete found with that id.' }); return; }
        target.parents = target.parents || [];
        const exists = target.parents.some(function (p) { return lc(p.email) === email; });
        if (!exists) target.parents.push({ email: email, pin: pin });
        await upsertRosterAthlete(target);
        res.status(200).json({ success: true, role: 'parent', name: name, athletes: [pub(target)] });
        return;
      }

      // ── athlete signup: auto-create Plan/Log/Meta, then write roster ──────
      // id slug from email, de-duplicated against current roster
      let base = email.replace(/[^a-z0-9]+/g, '') || ('rider' + Date.now());
      let id = base, n = 2;
      while (roster.some(function (a) { return a.id === id; })) { id = base + n; n++; }

      const planP = await A.createProject('RR ' + name + ' — Plan');
      const logP  = await A.createProject('RR ' + name + ' — Log');
      const metaP = await A.createProject('RR ' + name + ' — Meta');

      const athlete = {
        id: id,
        name: name,
        coachId: coach.id,
        planProjectId: planP.gid,
        logProjectId: logP.gid,
        metaProjectId: metaP.gid,
        athleteLogin: { email: email, pin: pin },
        parents: []
      };
      await upsertRosterAthlete(athlete);
      res.status(200).json({ success: true, role: 'athlete', name: name, athletes: [pub(athlete)] });
      return;
    }

    // ════ LOGIN ═════════════════════════════════════════════════════════════
    const email = lc(body.email);
    const pin = (body.pin || '').trim();
    if (!email || !pin) { res.status(400).json({ error: 'Email and PIN required' }); return; }

    const roster = await loadRoster();

    // ── admin (top tier; spans everything) ──────────────────────────────────
    const admins = asArray(parseJSONEnv('ADMIN', '{}')).filter(function (a) { return a && a.email; });
    const admin = admins.find(function (a) { return lc(a.email) === email && a.pin === pin; });
    if (admin) {
      res.status(200).json({
        success: true, role: 'admin', name: admin.name || 'Admin',
        athletes: roster.map(pub)
      });
      return;
    }

    // ── coach (scoped to own athletes only) ──────────────────────────────────
    const coach = coaches.find(function (p) { return lc(p.email) === email && p.pin === pin; });
    if (coach) {
      const mine = roster.filter(function (a) { return a.coachId && a.coachId === coach.id; });
      res.status(200).json({
        success: true, role: 'coach', name: coach.name || 'Coach',
        athletes: mine.map(pub)
      });
      return;
    }

    // ── parent ────────────────────────────────────────────────────────────────
    const guarded = roster.filter(function (a) {
      return (a.parents || []).some(function (p) { return lc(p.email) === email && p.pin === pin; });
    });
    if (guarded.length) {
      res.status(200).json({
        success: true, role: 'parent', name: body.displayName || 'Parent',
        athletes: guarded.map(pub)
      });
      return;
    }

    // ── athlete ────────────────────────────────────────────────────────────────
    const self = roster.find(function (a) {
      return a.athleteLogin && lc(a.athleteLogin.email) === email && a.athleteLogin.pin === pin;
    });
    if (self) {
      res.status(200).json({
        success: true, role: 'athlete', name: self.name, athletes: [pub(self)]
      });
      return;
    }

    res.status(401).json({ error: 'Email or PIN not recognised. Please try again or text Michelle for help.' });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
};
