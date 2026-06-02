// api/auth.js
// Username/PIN auth. Three roles:
//   coach    — the practitioner; sees ALL athletes
//   parent   — a guardian; sees only the athletes listed for them
//   athlete  — an individual rider; sees only themselves
//
// Env vars:
//   ASANA_TOKEN    Asana personal access token. IMPORTANT: generate this from the
//                  dedicated RACE DAY Asana account/workspace, NOT your WBD login.
//                  A PAT can reach every workspace its account belongs to, so using a
//                  RACE-DAY-only account is what guarantees this app never sees WBD.
//                  The project IDs below must be projects in that same workspace.
//   PRACTITIONER   JSON: { "email": "...", "pin": "...", "name": "Michelle" }
//   CLIENT_ROSTER  JSON array of athlete objects (see setup guide). Each athlete:
//     {
//       "id": "gavin",                 // stable slug, required (used everywhere)
//       "name": "Gavin M.",
//       "planProjectId": "12...",      // Asana project = this athlete's plan
//       "logProjectId":  "12...",      // Asana project = this athlete's log
//       "metaProjectId": "12...",      // Asana project = availability/messages/notes/toggles
//       "athleteLogin":  { "email": "gavin", "pin": "1234" },   // optional: athlete signs in
//       "parents": [ { "email": "michelle", "pin": "0000" } ]   // optional: one or more parents
//     }
//
// A parent may guard multiple athletes; the same parent email can appear on
// several athletes and we collect them all. The coach always sees everyone.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const email = (body.email || '').toLowerCase().trim();
    const pin = (body.pin || '').trim();
    if (!email || !pin) { res.status(400).json({ error: 'Email and PIN required' }); return; }

    const roster = JSON.parse(process.env.CLIENT_ROSTER || '[]');

    // public-safe view of one athlete (no PINs leak to the browser)
    const pub = function (a) {
      return {
        id: a.id,
        name: a.name,
        planProjectId: a.planProjectId || null,
        logProjectId: a.logProjectId || null,
        metaProjectId: a.metaProjectId || null
      };
    };

    // ── coach / practitioner ────────────────────────────────────────────────
    const practitioner = JSON.parse(process.env.PRACTITIONER || '{}');
    if (practitioner.email && practitioner.email.toLowerCase() === email && practitioner.pin === pin) {
      res.status(200).json({
        success: true,
        role: 'coach',
        name: practitioner.name || 'Coach',
        athletes: roster.map(pub)
      });
      return;
    }

    // ── parent ────────────────────────────────────────────────────────────────
    // collect every athlete that lists this email+pin as a parent
    const guarded = roster.filter(function (a) {
      return (a.parents || []).some(function (p) {
        return p.email && p.email.toLowerCase() === email && p.pin === pin;
      });
    });
    if (guarded.length) {
      res.status(200).json({
        success: true,
        role: 'parent',
        name: body.displayName || 'Parent',
        athletes: guarded.map(pub)
      });
      return;
    }

    // ── athlete ────────────────────────────────────────────────────────────────
    const self = roster.find(function (a) {
      return a.athleteLogin && a.athleteLogin.email &&
             a.athleteLogin.email.toLowerCase() === email && a.athleteLogin.pin === pin;
    });
    if (self) {
      res.status(200).json({
        success: true,
        role: 'athlete',
        name: self.name,
        athletes: [pub(self)]
      });
      return;
    }

    res.status(401).json({ error: 'Email or PIN not recognised. Please try again or text Michelle for help.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
