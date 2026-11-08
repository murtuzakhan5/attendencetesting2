const express = require('express');
const path = require('path');
const mongoose = require('mongoose');

const CONFIG = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGODB_URI,
  matchThreshold: Number(process.env.MATCH_THRESHOLD || 0.5),
  cooldownMs: 2 * 60 * 1000,
  shiftStart: process.env.SHIFT_START || '09:30',
  targetHours: Number(process.env.TARGET_HOURS || 8),
  tz: process.env.APP_TZ || 'Asia/Karachi',
};

// ---------- Models ----------
const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  descriptors: { type: [[Number]], required: true },
  enrolledAt: { type: Number, default: Date.now },
});

const attendanceSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  name: String,
  code: String,
  type: { type: String, enum: ['IN', 'OUT'], required: true },
  date: { type: String, required: true, index: true },   // YYYY-MM-DD
  time: { type: Number, required: true },                 // epoch ms
});
attendanceSchema.index({ date: 1, time: 1 });

const Employee = mongoose.model('Employee', employeeSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------- Helpers ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isId = id => mongoose.isValidObjectId(id);
const isValidDescriptor = d => Array.isArray(d) && d.length === 128 && d.every(Number.isFinite);

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.tz }).format(new Date());
const timeStr = ms => new Intl.DateTimeFormat('en-GB', {
  timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(ms));

// Punch logic: IN/OUT toggle + cooldown
async function recordPunch(emp) {
  const now = Date.now();
  const day = todayStr();
  const last = await Attendance.findOne({ employeeId: emp._id, date: day }).sort({ time: -1 }).lean();

  if (last && now - last.time < CONFIG.cooldownMs)
    return { ok: true, duplicate: true, name: emp.name, code: emp.code, type: last.type, timeStr: timeStr(last.time) };

  const type = !last || last.type === 'OUT' ? 'IN' : 'OUT';
  await Attendance.create({ employeeId: emp._id, name: emp.name, code: emp.code, type, date: day, time: now });
  return { ok: true, duplicate: false, name: emp.name, code: emp.code, type, timeStr: timeStr(now) };
}

// ---------- Config ----------
app.get('/api/config', (req, res) => {
  res.json({ shiftStart: CONFIG.shiftStart, targetHours: CONFIG.targetHours, tz: CONFIG.tz });
});

// ---------- Employees ----------
app.get('/api/employees', wrap(async (req, res) => {
  const list = await Employee.find({}, { descriptors: 0 }).sort({ name: 1 }).lean();
  res.json(list.map(e => ({ id: String(e._id), name: e.name, code: e.code, enrolledAt: e.enrolledAt })));
}));

app.post('/api/employees', wrap(async (req, res) => {
  const { name, code, descriptors } = req.body || {};
  if (!name || !code || !Array.isArray(descriptors) || descriptors.length === 0)
    return res.status(400).json({ error: 'Name, code and face data are required' });
  if (!descriptors.every(isValidDescriptor))
    return res.status(400).json({ error: 'Invalid face data' });

  try {
    const emp = await Employee.create({ name, code, descriptors });
    res.status(201).json({ ok: true, id: String(emp._id) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Employee code already exists' });
    throw e;
  }
}));

app.delete('/api/employees/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const r = await Employee.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Employee not found' });
  res.json({ ok: true });
}));

// Kiosk browser mein matching ke liye descriptors
app.get('/api/descriptors', wrap(async (req, res) => {
  const list = await Employee.find({}, { name: 1, code: 1, descriptors: 1 }).lean();
  res.json(list.map(e => ({ id: String(e._id), name: e.name, code: e.code, descriptors: e.descriptors })));
}));

// ---------- Attendance ----------
// Client-side matching ke baad punch (faster)
app.post('/api/punch', wrap(async (req, res) => {
  const { employeeId } = req.body || {};
  if (!isId(employeeId)) return res.status(400).json({ error: 'Invalid employee' });
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  res.json(await recordPunch(emp));
}));

// Server-side matching (agar descriptor bhejna ho)
app.post('/api/mark', wrap(async (req, res) => {
  const { descriptor } = req.body || {};
  if (!isValidDescriptor(descriptor)) return res.status(400).json({ error: 'Invalid face data' });

  const emps = await Employee.find({}).lean();
  let best = null, bestDist = Infinity;
  for (const emp of emps)
    for (const d of emp.descriptors) {
      const dist = distance(descriptor, d);
      if (dist < bestDist) { bestDist = dist; best = emp; }
    }

  if (!best || bestDist > CONFIG.matchThreshold)
    return res.status(404).json({ error: 'Face not recognized' });
  res.json(await recordPunch(best));
}));

app.get('/api/attendance', wrap(async (req, res) => {
  const date = req.query.date || todayStr();
  const rows = await Attendance.find({ date }).sort({ time: 1 }).lean();
  res.json(rows.map(a => ({
    employeeId: String(a.employeeId), name: a.name, code: a.code,
    type: a.type, date: a.date, time: a.time,
  })));
}));

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- Start ----------
async function start() {
  if (!CONFIG.mongoUri) throw new Error('MONGODB_URI environment variable is not set');
  await mongoose.connect(CONFIG.mongoUri);
  await Employee.init();   // unique index banata hai
  await Attendance.init();
  console.log('MongoDB connected');
  app.listen(CONFIG.port, () => console.log(`Running on port ${CONFIG.port}`));
}
start().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });