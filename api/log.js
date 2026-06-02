// api/log.js
// The LOG half of the model + the conversational/meta records that pair with it.
//
// LOG project (per athlete): one task per logged entry. Notes hold:
//   Exercise: Trap Bar Deadlift
//   Date: 2026-05-26
//   Cat: Strength
//   Sets: [{"w":"165","r":5}, ...]      // JSON; strength entries
//   Best: 82                            // optional single-number entries (broad jump)
//   SkillNote: <text>                   // sprint/roller/track entries (notes-only)
//   Note: <free text>
//   By: athlete
//
// META project (per athlete) singletons:
//   Messages           — Messages: [ {id,from,to,visibility,text,date,cleared} ]
//   Chart Toggles      — Toggles: { "Trap Bar Deadlift": true, ... }   coach-controlled
//   Coach Notes        — Goals/Strengths/Weaknesses snapshots + QuickNotes log (coach-eyes-only)

const A = require('./_asana');

const LOG_PREFIX = 'Log \u2014 ';
function logName(exercise, date) { return LOG_PREFIX + exercise + ' \u2014 ' + date; }

// ── reading the log ─────────────────────────────────────────────────────────
async function readLog(logProjectId) {
  const tasks = await A.listProjectTasks(logProjectId);
  const entries = [];
  tasks.forEach(function (t) {
    if (!t.name || t.name.indexOf(LOG_PREFIX) !== 0) return;
    const r = A.decodeRecord(t.notes);
    if (!r.Exercise) return;
    entries.push({
      gid: t.gid,
      exercise: r.Exercise,
      date: r.Date || '',
      cat: r.Cat || '',
      sets: Array.isArray(r.Sets) ? r.Sets : [],
      best: (typeof r.Best === 'number') ? r.Best : (r.Best ? Number(r.Best) || null : null),
      skillNote: r.SkillNote || '',
      note: r.Note || '',
      by: r.By || ''
    });
  });
  return entries;
}

// carry-over math (mirrors the preview's topLoad / carryFor / summarize)
function topLoad(e) {
  const nums = (e.sets || []).map(function (s) { return parseFloat(String(s.w)); }).filter(function (x) { return !isNaN(x); });
  if (nums.length) return Math.max.apply(null, nums);
  if (e.best) return e.best;
  const reps = (e.sets || []).map(function (s) { return s.r; }).filter(function (x) { return typeof x === 'number' && x > 0; });
  return reps.length ? Math.max.apply(null, reps) : null;
}
function summarize(e) {
  if (e.best) return e.best + ' in';
  const t = (e.sets || []).filter(function (s) { return s.w !== '' && s.w != null; });
  if (!t.length) return (e.sets || []).map(function (s) { return s.r; }).join(', ') + ' reps';
  let best = t[0], bn = -Infinity;
  t.forEach(function (s) { const n = parseFloat(String(s.w)); if (!isNaN(n) && n > bn) { bn = n; best = s; } });
  if (isNaN(parseFloat(String(best.w)))) return best.w + ' \u00d7 ' + best.r;
  return best.w + ' lb \u00d7 ' + best.r;
}
function carryFor(entries, name) {
  const h = entries.filter(function (e) { return e.exercise === name && !e.skillNote; })
    .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  if (!h.length) return { last: null, pr: null };
  let pv = -Infinity, pe = null;
  h.forEach(function (e) { const t = topLoad(e); if (t !== null && t > pv) { pv = t; pe = e; } });
  return { last: summarize(h[0]), pr: pe ? summarize(pe) : null };
}

// build a compact carry-over map { exerciseName: {last, pr} } for the builder
function carryMap(entries) {
  const names = {};
  entries.forEach(function (e) { if (!e.skillNote) names[e.exercise] = true; });
  const out = {};
  Object.keys(names).forEach(function (n) { out[n] = carryFor(entries, n); });
  return out;
}

// ── singletons ──────────────────────────────────────────────────────────────
const MSG_TASK = 'Messages';
const TOGGLE_TASK = 'Chart Toggles';
const NOTES_TASK = 'Coach Notes';

async function readSingleton(metaProjectId, taskName, field, fallback) {
  const t = await A.getOrCreateSingleton(metaProjectId, taskName, A.encodeRecord({ [field]: fallback }));
  const rec = A.decodeRecord(t.notes);
  const val = rec[field];
  return { gid: t.gid, value: (val !== undefined ? val : fallback), rec: rec };
}
async function writeSingleton(metaProjectId, taskName, fields) {
  const t = await A.getOrCreateSingleton(metaProjectId, taskName, '');
  // merge into whatever's there so we don't clobber sibling fields
  const cur = A.decodeRecord(t.notes);
  Object.keys(fields).forEach(function (k) { cur[k] = fields[k]; });
  await A.updateTask(t.gid, { notes: A.encodeRecord(cur) });
  return { gid: t.gid };
}

module.exports = async function handler(req, res) {
  if (A.preflight(req, res, 'GET, POST, OPTIONS')) return;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};

      if (q.action === 'log') {
        const entries = await readLog(q.logProjectId);
        res.status(200).json({ success: true, entries: entries, carry: carryMap(entries) });
        return;
      }
      if (q.action === 'messages') {
        const r = await readSingleton(q.metaProjectId, MSG_TASK, 'Messages', []);
        res.status(200).json({ success: true, gid: r.gid, messages: r.value });
        return;
      }
      if (q.action === 'toggles') {
        const r = await readSingleton(q.metaProjectId, TOGGLE_TASK, 'Toggles', {});
        res.status(200).json({ success: true, gid: r.gid, toggles: r.value });
        return;
      }
      if (q.action === 'coach_notes') {
        // coach-eyes-only; the frontend gates this to role==='coach'
        const r = await readSingleton(q.metaProjectId, NOTES_TASK, 'Goals', '');
        res.status(200).json({
          success: true,
          notes: {
            goals: r.rec.Goals || '',
            strengths: r.rec.Strengths || '',
            weaknesses: r.rec.Weaknesses || '',
            quick: Array.isArray(r.rec.QuickNotes) ? r.rec.QuickNotes : []
          }
        });
        return;
      }
      res.status(400).json({ error: 'Unknown GET action' });
      return;
    }

    if (req.method === 'POST') {
      const body = A.readBody(req);
      const action = body.action;

      if (action === 'add_entry') {
        const e = body.entry || {};
        const fields = {
          Exercise: e.exercise,
          Date: e.date,
          Cat: e.cat || '',
          By: e.by || ''
        };
        if (e.skillNote) fields.SkillNote = e.skillNote;
        if (e.best != null && e.best !== '') fields.Best = e.best;
        if (Array.isArray(e.sets) && e.sets.length) fields.Sets = e.sets;
        if (e.note) fields.Note = e.note;
        const task = await A.createTask({
          name: logName(e.exercise, e.date),
          notes: A.encodeRecord(fields),
          projects: [body.logProjectId]
        });
        res.status(200).json({ success: true, gid: task.gid });
        return;
      }
      if (action === 'save_messages') {
        const r = await writeSingleton(body.metaProjectId, MSG_TASK, { Messages: body.messages || [] });
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      if (action === 'save_toggles') {
        const r = await writeSingleton(body.metaProjectId, TOGGLE_TASK, { Toggles: body.toggles || {} });
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      if (action === 'save_coach_notes') {
        // snapshot blocks replace; quick-notes are append-only (frontend sends full list)
        const n = body.notes || {};
        const fields = {
          Goals: n.goals || '',
          Strengths: n.strengths || '',
          Weaknesses: n.weaknesses || ''
        };
        if (Array.isArray(n.quick)) fields.QuickNotes = n.quick;
        const r = await writeSingleton(body.metaProjectId, NOTES_TASK, fields);
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      res.status(400).json({ error: 'Unknown POST action' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
