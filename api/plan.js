// api/plan.js
// The PLAN half of the model:
//   Project (per athlete)  = the plan
//   Section                = a week  ("Week of 2026-06-01")
//   Task                   = a day   (name = "Day 2026-06-02 — <label>")
//   Subtask                = a session, with its moves serialized in notes
//
// A day task's notes hold day-level structured fields:
//   Date: 2026-06-02
//   Label: Strength A + Charlotte Gates
//   Badges: ["Strength","Charlotte"]
//   Rest: false
//   Note: <rest-day note, optional>
//   Skipped: {"Strength A":{"reason":"Rain","by":"athlete"}}   // per-session skip map
//
// Each session subtask's notes hold:
//   Tag: AM
//   Blocks: [ {type:"move",move:{...}}, {type:"circuit",name,rounds,restBetween,moves:[...]} ]
//   Moves:  [ {name,cat,type,video,spec:{...}}, ... ]   // legacy flat list (pre-circuits)
// A session has EITHER Blocks (current) OR Moves (legacy). The reader returns
// both fields and the frontend adapts legacy Moves into a single move-block.
//
// Events, recurring availability, the exercise library and session templates
// are plan-adjacent. They live as singleton tasks in the athlete's META project
// so the builder can read them in one place.

const A = require('./_asana');

const DAY_PREFIX = 'Day ';
function dayName(date, label) { return DAY_PREFIX + date + (label ? ' \u2014 ' + label : ''); }
function dateFromDayName(name) {
  if (!name) return null;
  const m = name.match(/^Day\s+(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function weekSectionName(mondayISO) { return 'Week of ' + mondayISO; }
function mondayOf(dateISO) {
  const d = new Date(dateISO + 'T12:00:00');
  const m = new Date(d);
  m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return m.toISOString().slice(0, 10);
}

// read all day tasks for a plan project, decoded into day records keyed by date
async function readAllDays(planProjectId) {
  const tasks = await A.listProjectTasks(planProjectId);
  const days = {};
  tasks.forEach(function (t) {
    const date = dateFromDayName(t.name);
    if (!date) return;
    const rec = A.decodeRecord(t.notes);
    days[date] = {
      gid: t.gid,
      date: date,
      label: rec.Label || '',
      badges: Array.isArray(rec.Badges) ? rec.Badges : [],
      rest: rec.Rest === true,
      note: rec.Note || '',
      moveCount: (rec.MoveCount != null && rec.MoveCount !== '' && !isNaN(rec.MoveCount)) ? Number(rec.MoveCount) : null,
      sessions: Array.isArray(rec.Sessions) ? rec.Sessions : null,
      skipped: (rec.Skipped && typeof rec.Skipped === 'object') ? rec.Skipped : {},
      done: (rec.Done && typeof rec.Done === 'object') ? rec.Done : {}
    };
  });
  return days;
}

async function readDayFull(planProjectId, date) {
  const tasks = await A.listProjectTasks(planProjectId);
  const dayTask = tasks.find(function (t) { return dateFromDayName(t.name) === date; });
  if (!dayTask) return null;
  const rec = A.decodeRecord(dayTask.notes);
  const subs = await A.listSubtasks(dayTask.gid);
  const sessions = subs.map(function (s) {
    const sr = A.decodeRecord(s.notes);
    return {
      gid: s.gid,
      name: s.name,
      tag: sr.Tag || '',
      // Blocks is the current shape (moves + circuits). Moves is the legacy flat
      // list, kept for days saved before circuits existed; the frontend adapts it.
      blocks: Array.isArray(sr.Blocks) ? sr.Blocks : null,
      moves: Array.isArray(sr.Moves) ? sr.Moves : []
    };
  });
  return {
    gid: dayTask.gid,
    date: date,
    label: rec.Label || '',
    badges: Array.isArray(rec.Badges) ? rec.Badges : [],
    rest: rec.Rest === true,
    note: rec.Note || '',
    feedback: rec.Feedback || '',
    skipped: (rec.Skipped && typeof rec.Skipped === 'object') ? rec.Skipped : {},
    done: (rec.Done && typeof rec.Done === 'object') ? rec.Done : {},
    sessions: sessions
  };
}

// write/replace a single day (used by the builder's "Save day to plan")
async function saveDay(planProjectId, day) {
  const date = day.date;

  // find existing day task first so we can preserve coach Feedback across re-saves
  const tasks = await A.listProjectTasks(planProjectId);
  let dayTask = tasks.find(function (t) { return dateFromDayName(t.name) === date; });

  // An empty, non-rest day means "no plan" — there is nothing to schedule. If a day
  // task already exists (e.g. its last session was just deleted), remove it entirely
  // so the day reads back as unplanned rather than lingering as an empty shell.
  const hasSessions = Array.isArray(day.sessions) && day.sessions.length > 0;
  if (!day.rest && !hasSessions) {
    if (dayTask) {
      const existingSubs = await A.listSubtasks(dayTask.gid);
      for (let i = 0; i < existingSubs.length; i++) await A.deleteTask(existingSubs[i].gid);
      await A.deleteTask(dayTask.gid);
    }
    return { gid: null, deleted: true };
  }

  const prior = dayTask ? A.decodeRecord(dayTask.notes) : {};

  // Count prescribed moves across sessions so the week-at-a-glance can judge
  // completion from the day summary alone (no per-day subtask fetch on home).
  let moveCount = 0;
  if (!day.rest && Array.isArray(day.sessions)) {
    day.sessions.forEach(function (s) {
      const blocks = Array.isArray(s.blocks) ? s.blocks : null;
      if (blocks) {
        blocks.forEach(function (b) { moveCount += (b && b.type === 'circuit') ? ((b.moves || []).length) : 1; });
      } else {
        moveCount += (s.moves || []).length;
      }
    });
  }

  // Per-session descriptor for the glance: ordered AM→PM→untagged, each {tag,type,label}.
  // type = canonical key of the session's FIRST move's category (matches client typeKey()).
  function srvTypeKey(cat){
    var c=(cat||'').toLowerCase();
    if(c.indexOf('strength')>=0)return 'strength';
    if(c.indexOf('sprint')>=0)return 'sprints';
    if(c.indexOf('roller')>=0)return 'roller';
    return 'track';
  }
  function srvFirstCat(s){
    var blocks=Array.isArray(s.blocks)?s.blocks:null;
    if(blocks&&blocks.length){var b=blocks[0];if(b.type==='circuit')return (b.moves&&b.moves[0]&&b.moves[0].cat)||null;return (b.move&&b.move.cat)||null;}
    var mv=(s.moves||[])[0];return mv?(mv.cat||null):null;
  }
  let sessionsDesc = [];
  if (!day.rest && Array.isArray(day.sessions)) {
    const rank = { 'AM':0, 'PM':1 };
    sessionsDesc = day.sessions.map(function(s){
      const cat=srvFirstCat(s);
      return { tag: s.tag||'—', type: cat?srvTypeKey(cat):null, label: s.name||'' };
    }).sort(function(a,b){
      const ra=(a.tag in rank)?rank[a.tag]:2, rb=(b.tag in rank)?rank[b.tag]:2;
      return ra-rb;
    });
  }

  const dayFields = {
    Date: date,
    Label: day.label || '',
    Badges: day.badges || [],
    Rest: !!day.rest,
    Note: day.note || '',
    MoveCount: moveCount,
    Sessions: sessionsDesc,
    Skipped: day.skipped || prior.Skipped || {}
  };
  if (prior.Feedback) dayFields.Feedback = prior.Feedback;
  if (prior.Done) dayFields.Done = prior.Done;
  const dayNotes = A.encodeRecord(dayFields);

  if (!dayTask) {
    dayTask = await A.createTask({ name: dayName(date, day.label), notes: dayNotes, projects: [planProjectId] });
    // file under the right week section
    const sectionGid = await A.getOrCreateSection(planProjectId, weekSectionName(mondayOf(date)));
    if (sectionGid) await A.addTaskToSection(sectionGid, dayTask.gid);
  } else {
    await A.updateTask(dayTask.gid, { name: dayName(date, day.label), notes: dayNotes });
  }

  // rewrite sessions: delete existing subtasks, recreate from payload
  const existingSubs = await A.listSubtasks(dayTask.gid);
  for (let i = 0; i < existingSubs.length; i++) {
    await A.deleteTask(existingSubs[i].gid);
  }
  if (!day.rest && Array.isArray(day.sessions)) {
    for (let i = 0; i < day.sessions.length; i++) {
      const s = day.sessions[i];
      // Prefer the new Blocks shape; fall back to Moves for callers that still
      // send a flat list. We never write both, to avoid the reader having to
      // reconcile them.
      const sessionFields = { Tag: s.tag || '' };
      if (Array.isArray(s.blocks)) sessionFields.Blocks = s.blocks;
      else sessionFields.Moves = s.moves || [];
      await A.createSubtask(dayTask.gid, {
        name: s.name || ('Session ' + (i + 1)),
        notes: A.encodeRecord(sessionFields)
      });
    }
  }
  return { gid: dayTask.gid };
}

// per-session skip toggle (athlete or coach marks a session not completed)
async function setSkip(planProjectId, date, sessionName, skipObj) {
  const tasks = await A.listProjectTasks(planProjectId);
  const dayTask = tasks.find(function (t) { return dateFromDayName(t.name) === date; });
  if (!dayTask) throw new Error('Day not found');
  const rec = A.decodeRecord(dayTask.notes);
  const skipped = (rec.Skipped && typeof rec.Skipped === 'object') ? rec.Skipped : {};
  if (skipObj) skipped[sessionName] = skipObj;
  else delete skipped[sessionName];
  rec.Skipped = skipped;
  await A.updateTask(dayTask.gid, { notes: A.encodeRecord(rec) });
  return skipped;
}

// ── singletons stored in the META project ──────────────────────────────────
const LIB_TASK = 'Exercise Library';
const TMPL_TASK = 'Session Templates';
const EVENTS_TASK = 'Calendar Events';
const AVAIL_TASK = 'Weekly Availability';

async function readSingletonJSON(metaProjectId, taskName, field, fallback) {
  const t = await A.getOrCreateSingleton(metaProjectId, taskName, A.encodeRecord({ [field]: fallback }));
  const rec = A.decodeRecord(t.notes);
  const val = rec[field];
  return { gid: t.gid, value: (val !== undefined ? val : fallback) };
}
async function writeSingletonJSON(metaProjectId, taskName, field, value) {
  const t = await A.getOrCreateSingleton(metaProjectId, taskName, '');
  await A.updateTask(t.gid, { notes: A.encodeRecord({ [field]: value }) });
  return { gid: t.gid };
}

module.exports = async function handler(req, res) {
  if (A.preflight(req, res, 'GET, POST, OPTIONS')) return;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const planProjectId = q.planProjectId;
      if (!planProjectId && !q.metaProjectId && !q.libraryProjectId) { res.status(400).json({ error: 'planProjectId required' }); return; }

      if (q.action === 'days') {           // month/week overview
        const days = await readAllDays(planProjectId);
        res.status(200).json({ success: true, days: days });
        return;
      }
      if (q.action === 'day') {            // one full day w/ sessions + moves
        if (!q.date) { res.status(400).json({ error: 'date required' }); return; }
        const day = await readDayFull(planProjectId, q.date);
        res.status(200).json({ success: true, day: day });
        return;
      }
      if (q.action === 'library') {
        const libPid = q.libraryProjectId || q.metaProjectId;
        const r = await readSingletonJSON(libPid, LIB_TASK, 'Library', []);
        res.status(200).json({ success: true, gid: r.gid, library: r.value });
        return;
      }
      if (q.action === 'templates') {
        const libPid = q.libraryProjectId || q.metaProjectId;
        const r = await readSingletonJSON(libPid, TMPL_TASK, 'Templates', []);
        res.status(200).json({ success: true, gid: r.gid, templates: r.value });
        return;
      }
      if (q.action === 'events') {
        const r = await readSingletonJSON(q.metaProjectId, EVENTS_TASK, 'Events', []);
        res.status(200).json({ success: true, gid: r.gid, events: r.value });
        return;
      }
      if (q.action === 'availability') {
        const r = await readSingletonJSON(q.metaProjectId, AVAIL_TASK, 'Availability', {});
        res.status(200).json({ success: true, gid: r.gid, availability: r.value });
        return;
      }
      res.status(400).json({ error: 'Unknown GET action' });
      return;
    }

    if (req.method === 'POST') {
      const body = A.readBody(req);
      const action = body.action;
      const planProjectId = body.planProjectId;
      const metaProjectId = body.metaProjectId;

      if (action === 'save_day') {
        const r = await saveDay(planProjectId, body.day);
        res.status(200).json({ success: true, gid: r.gid, deleted: !!r.deleted });
        return;
      }
      if (action === 'skip') {
        const skipped = await setSkip(planProjectId, body.date, body.sessionName, body.skip || null);
        res.status(200).json({ success: true, skipped: skipped });
        return;
      }
      if (action === 'toggle_done') {
        // body: { date, key, done }  — key is `${session}__${move}`
        const tasks = await A.listProjectTasks(planProjectId);
        const dayTask = tasks.find(function (t) { return dateFromDayName(t.name) === body.date; });
        if (!dayTask) { res.status(404).json({ error: 'Day not found' }); return; }
        const rec = A.decodeRecord(dayTask.notes);
        const done = (rec.Done && typeof rec.Done === 'object') ? rec.Done : {};
        if (body.done) done[body.key] = true; else delete done[body.key];
        rec.Done = done;
        await A.updateTask(dayTask.gid, { notes: A.encodeRecord(rec) });
        res.status(200).json({ success: true, done: done });
        return;
      }
      if (action === 'set_feedback') {
        // coach day-note: stored on the day task's Note? No — feedback is coach->athlete
        // per-day and kept separate from rest-notes. Store as "Feedback" field on day task.
        const tasks = await A.listProjectTasks(planProjectId);
        const dayTask = tasks.find(function (t) { return dateFromDayName(t.name) === body.date; });
        if (!dayTask) { res.status(404).json({ error: 'Day not found — save a plan for it first' }); return; }
        const rec = A.decodeRecord(dayTask.notes);
        if (body.feedback) rec.Feedback = body.feedback; else delete rec.Feedback;
        await A.updateTask(dayTask.gid, { notes: A.encodeRecord(rec) });
        res.status(200).json({ success: true });
        return;
      }
      if (action === 'save_library') {
        const libPid = body.libraryProjectId || metaProjectId;
        const r = await writeSingletonJSON(libPid, LIB_TASK, 'Library', body.library || []);
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      if (action === 'save_templates') {
        const libPid = body.libraryProjectId || metaProjectId;
        const r = await writeSingletonJSON(libPid, TMPL_TASK, 'Templates', body.templates || []);
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      if (action === 'save_events') {
        const r = await writeSingletonJSON(metaProjectId, EVENTS_TASK, 'Events', body.events || []);
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      if (action === 'save_availability') {
        // shared record — all roles may write it
        const r = await writeSingletonJSON(metaProjectId, AVAIL_TASK, 'Availability', body.availability || {});
        res.status(200).json({ success: true, gid: r.gid });
        return;
      }
      res.status(400).json({ error: 'Unknown POST action' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }
};

// expose helpers for feedback read inside day (used by frontend via 'day' action — already included in decodeRecord)
module.exports._internal = { dayName, dateFromDayName, mondayOf, weekSectionName };
