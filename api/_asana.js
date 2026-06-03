// api/_asana.js
// Shared helpers for talking to Asana and for the "structured text in notes" pattern.
// Every other function file requires this. It is NOT itself an HTTP endpoint
// (the leading underscore keeps Vercel from routing to it).

const ASANA_BASE = 'https://app.asana.com/api/1.0';

function token() {
  const t = process.env.ASANA_TOKEN;
  if (!t) throw new Error('ASANA_TOKEN not set');
  return t;
}

// ── core fetch wrapper ──────────────────────────────────────────────────────
async function asana(path, method, body) {
  const r = await fetch(ASANA_BASE + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token(),
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json();
  if (!r.ok) {
    const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || ('Asana ' + r.status);
    const e = new Error(msg);
    e.status = r.status;
    e.asana = json;
    throw e;
  }
  return json;
}

// ── CORS + body helpers ─────────────────────────────────────────────────────
function cors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', (methods || 'GET, POST, OPTIONS'));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function preflight(req, res, methods) {
  cors(res, methods);
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}
function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

// ── structured-notes serialization ──────────────────────────────────────────
// The WBD pattern stores a record's fields as labelled lines in a task's `notes`.
// We use a tiny, forgiving "Key: value" format with a JSON escape hatch for
// nested data (sessions, moves, sets). Parsing tolerates hand edits in Asana.
//
// A "record" is a flat object whose values are strings, numbers, booleans,
// or (for complex fields) objects/arrays which we JSON-encode on one line.

function encodeRecord(obj) {
  const lines = [];
  Object.keys(obj).forEach(function (k) {
    let v = obj[k];
    if (v === undefined || v === null) return;
    if (typeof v === 'object') {
      lines.push(k + ': ' + JSON.stringify(v));
    } else {
      // keep multi-line strings intact by indenting continuation lines
      const s = String(v).replace(/\n/g, '\n  ');
      lines.push(k + ': ' + s);
    }
  });
  return lines.join('\n');
}

function decodeRecord(notes) {
  const out = {};
  if (!notes) return out;
  const rawLines = String(notes).split('\n');
  let curKey = null;
  let buf = [];
  const flush = function () {
    if (curKey === null) return;
    let val = buf.join('\n');
    out[curKey] = val;
    curKey = null; buf = [];
  };
  rawLines.forEach(function (line) {
    // a new key starts at column 0 as `Key: ...`; continuation lines are indented
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _\-]*?):\s?([\s\S]*)$/);
    if (m && !/^\s\s/.test(line)) {
      flush();
      curKey = m[1].trim();
      buf = [m[2]];
    } else {
      buf.push(line.replace(/^\s\s/, ''));
    }
  });
  flush();
  // attempt JSON decode on values that look like JSON
  Object.keys(out).forEach(function (k) {
    const v = out[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { out[k] = JSON.parse(t); } catch (e) { /* leave as string */ }
      } else if (t === 'true' || t === 'false') {
        out[k] = (t === 'true');
      }
    }
  });
  return out;
}

// ── task / section convenience ──────────────────────────────────────────────
async function listProjectTasks(projectId, extraFields) {
  const fields = 'name,notes,completed' + (extraFields ? ',' + extraFields : '');
  const d = await asana('/projects/' + projectId + '/tasks?opt_fields=' + fields + '&limit=100');
  return d.data || [];
}
async function listSubtasks(taskGid) {
  const d = await asana('/tasks/' + taskGid + '/subtasks?opt_fields=name,notes,completed&limit=100');
  return d.data || [];
}
async function getTask(taskGid, extraFields) {
  const fields = 'name,notes,completed' + (extraFields ? ',' + extraFields : '');
  const d = await asana('/tasks/' + taskGid + '?opt_fields=' + fields);
  return d.data || null;
}
async function createTask(data) {
  const d = await asana('/tasks', 'POST', { data: data });
  return d.data;
}
async function updateTask(taskGid, data) {
  const d = await asana('/tasks/' + taskGid, 'PUT', { data: data });
  return d.data;
}
async function deleteTask(taskGid) {
  return asana('/tasks/' + taskGid, 'DELETE');
}
async function createSubtask(parentGid, data) {
  const d = await asana('/tasks/' + parentGid + '/subtasks', 'POST', { data: data });
  return d.data;
}
async function getSections(projectId) {
  const d = await asana('/projects/' + projectId + '/sections?opt_fields=name,gid');
  return d.data || [];
}
async function createSection(projectId, name) {
  const d = await asana('/projects/' + projectId + '/sections', 'POST', { data: { name: name } });
  return d.data;
}
async function addTaskToSection(sectionGid, taskGid) {
  return asana('/sections/' + sectionGid + '/addTask', 'POST', { data: { task: taskGid } });
}

// find or create a section by (case-insensitive) name
async function getOrCreateSection(projectId, name) {
  const sections = await getSections(projectId);
  const want = name.trim().toLowerCase();
  const existing = sections.find(function (s) { return s.name && s.name.trim().toLowerCase() === want; });
  if (existing) return existing.gid;
  const created = await createSection(projectId, name);
  return created && created.gid;
}

// find or create a singleton task by exact name within a project; returns the task
async function getOrCreateSingleton(projectId, name, initialNotes) {
  const tasks = await listProjectTasks(projectId);
  const existing = tasks.find(function (t) { return t.name && t.name.trim() === name.trim(); });
  if (existing) return existing;
  return createTask({ name: name, notes: initialNotes || '', projects: [projectId] });
}

module.exports = {
  asana, cors, preflight, readBody,
  encodeRecord, decodeRecord,
  listProjectTasks, listSubtasks, getTask, createTask, updateTask, deleteTask,
  createSubtask, getSections, createSection, addTaskToSection,
  getOrCreateSection, getOrCreateSingleton
};
