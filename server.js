const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const db = require('./database');
const fs = require('fs');
const multer = require('multer'); 
const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'habit-app-secret-key';

// 添加原生 sqlite3 支持（用于多行查询）
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
let rawDb;
// 初始化 rawDb（异步，但会在第一次请求时等待）
const initRawDb = async () => {
  if (!rawDb) {
    rawDb = await open({ filename: './data.db', driver: sqlite3.Database });
  }
  return rawDb;
};
// 启动时不等待，在第一个请求中初始化
initRawDb().catch(err => console.error('rawDb 初始化失败:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'public/uploads/avatars');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置存储
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const userId = req.userId;
    const ext = path.extname(file.originalname);
    // 统一命名为 user_${userId}.jpg 等，避免重复
    cb(null, `user_${userId}${ext}`);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext) && allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只支持 jpg/png/gif 格式'));
    }
  }
});

// ---------- 辅助函数：兼容 db.execute 的返回格式 ----------
// db.execute 总是返回 [result]
// 对于 SELECT 单行：result 是对象
// 对于 SELECT 多行：result 是数组
// 对于 INSERT/UPDATE：result 是 { insertId, affectedRows }
async function queryOne(sql, params = []) {
  const [result] = await db.execute(sql, params);
  // 如果 result 是数组（多行），返回第一行；否则直接返回 result（单行对象或 undefined）
  return Array.isArray(result) ? result[0] : result;
}

async function queryAll(sql, params = []) {
  const [result] = await db.execute(sql, params);
  // 如果 result 是数组，直接返回；否则（单行对象）包装成数组
  return Array.isArray(result) ? result : (result ? [result] : []);
}

async function queryRun(sql, params = []) {
  const [result] = await db.execute(sql, params);
  return result; // { insertId, affectedRows }
}

// ---------- 认证中间件 ----------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证令牌' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '令牌无效或已过期' });
    req.userId = user.userId;
    next();
  });
}

// ---------- PushPlus 发送 ----------
async function sendPushPlusToUser(token, title, content) {
  if (!token) return false;
  try {
    const response = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, content, template: 'html' })
    });
    const data = await response.json();
    return data.code === 200;
  } catch (e) {
    console.error('PushPlus 发送失败:', e);
    return false;
  }
}

// ---------- 计算连续打卡天数 ----------
async function calculateStreak(userId, checkToday = true) {
  const rows = await queryAll('SELECT date FROM checkins WHERE user_id=? ORDER BY date DESC', [userId]);
  if (rows.length === 0) return 0;
  let streak = 0;
  let currentDate = new Date();
  if (!checkToday) currentDate.setDate(currentDate.getDate() - 1);
  for (let row of rows) {
    const expected = new Date(currentDate);
    expected.setDate(expected.getDate() - streak);
    if (row.date === expected.toISOString().slice(0, 10)) streak++;
    else break;
  }
  return streak;
}

// ---------- 每日励志语 ----------
const quotes = [
  "自律，是最高级的欲望管理。",
  "每一次克制，都让灵魂更轻盈。",
  "不要为短暂快乐透支未来的安宁。",
  "你比自己想象的更强大。",
  "坚持的意义，会在未来某一刻绽放。",
  "干净的灵魂，才配得上高级的爱。",
  "别让冲动，偷走你的光芒。"
];
function getDailyQuote() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return quotes[dayOfYear % quotes.length];
}

// ================= 注册 =================
app.post('/api/register', async (req, res) => {
  const { username, password, pushplus_token } = req.body;
  console.log(`注册请求: username=${username}, password=${password}`);
  try {
    const result = await queryRun(
      'INSERT INTO users (username, password, pushplus_token) VALUES (?, ?, ?)',
      [username, password, pushplus_token || null]
    );
    const userId = result.lastID;
    await queryRun('INSERT INTO points (user_id, balance) VALUES (?, 0)', [userId]);
    console.log(`注册成功: userId=${userId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('注册错误:', e);
    if (e.code === 'SQLITE_CONSTRAINT') {
      res.status(400).json({ error: '用户名已存在' });
    } else {
      res.status(500).json({ error: '注册失败' });
    }
  }
});

// ================= 登录 =================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`登录尝试: username=${username}, password=${password}`);
  const user = await queryOne('SELECT * FROM users WHERE username=? AND password=?', [username, password]);
  console.log('查询到的用户:', user);
  if (!user) {
    console.log('登录失败: 用户不存在或密码错误');
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  console.log(`登录成功: userId=${user.id}`);
  res.json({ success: true, token, pushplus_token: user.pushplus_token || '' });
});

// ================= 获取状态 =================
app.get('/api/status', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const today = new Date().toISOString().slice(0, 10);
  const check = await queryOne('SELECT id FROM checkins WHERE user_id=? AND date=?', [userId, today]);
  const checkedToday = !!check;
  const streak = await calculateStreak(userId, checkedToday);
  const pointRow = await queryOne('SELECT balance FROM points WHERE user_id=?', [userId]);
  const balance = pointRow?.balance || 0;
  res.json({
    checked: checkedToday,
    streak,
    points: balance,
    quote: getDailyQuote()
  });
});

// ================= 打卡 =================
app.post('/api/checkin', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await queryRun('INSERT INTO checkins (user_id, date) VALUES (?, ?)', [userId, today]);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: '今天已经打过卡了' });
    }
    return res.status(500).json({ error: '打卡失败' });
  }
  await queryRun('UPDATE points SET balance = balance + 1 WHERE user_id = ?', [userId]);
  const streak = await calculateStreak(userId, true);
  if (streak > 0 && streak % 7 === 0) {
    await queryRun('UPDATE points SET balance = balance + 1 WHERE user_id = ?', [userId]);
    const user = await queryOne('SELECT pushplus_token FROM users WHERE id=?', [userId]);
    if (user?.pushplus_token) {
      await sendPushPlusToUser(user.pushplus_token, '🎉 连续坚持奖励', `恭喜你连续坚持 ${streak} 天，获得额外 1 积分！`);
    }
  }
  const user = await queryOne('SELECT pushplus_token FROM users WHERE id=?', [userId]);
  if (user?.pushplus_token) {
    await sendPushPlusToUser(user.pushplus_token, '✅ 打卡成功', `今日打卡完成，已连续坚持 ${streak} 天！`);
  }
  res.json({ success: true, streak });
});

// ================= 自我提醒 =================
app.post('/api/remind', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const user = await queryOne('SELECT pushplus_token FROM users WHERE id=?', [userId]);
  if (!user?.pushplus_token) {
    return res.status(400).json({ error: '请先在设置中配置 PushPlus Token' });
  }
  const success = await sendPushPlusToUser(user.pushplus_token, '💪 自我提醒', '提醒：今天的目标还没完成，快去打卡吧！');
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '提醒发送失败，请检查 Token 是否有效' });
  }
});

// ================= 获取/修改用户 PushPlus Token =================
app.get('/api/user/token', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const user = await queryOne('SELECT pushplus_token FROM users WHERE id=?', [userId]);
  res.json({ token: user?.pushplus_token || '' });
});
app.post('/api/user/token', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { token } = req.body;
  await queryRun('UPDATE users SET pushplus_token=? WHERE id=?', [token || null, userId]);
  res.json({ success: true });
});

// ================= 奖励列表 =================
app.get('/api/rewards', (req, res) => {
  res.json([
    { name: '一杯奶茶', cost: 3 },
    { name: '一顿饭', cost: 5 },
    { name: '实现一个愿望', cost: 10 }
  ]);
});

// ================= 愿望系统 =================
app.post('/api/wishes', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { wish } = req.body;
  if (!wish || wish.trim() === '') return res.status(400).json({ error: '愿望不能为空' });
  const existing = await queryOne("SELECT id FROM wishes WHERE user_id=? AND status='active'", [userId]);
  if (existing) return res.status(400).json({ error: '你还有一个未实现的愿望，请先兑换或取消' });
  await queryRun('INSERT INTO wishes (user_id, wish_text, status) VALUES (?, ?, ?)', [userId, wish, 'active']);
  res.json({ success: true });
});
app.get('/api/wishes', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const wishes = await queryAll("SELECT * FROM wishes WHERE user_id=? ORDER BY created_at DESC", [userId]);
  res.json({ wishes });
});
app.post('/api/wishes/:id/cancel', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const wishId = req.params.id;
  const wish = await queryOne('SELECT * FROM wishes WHERE id=? AND user_id=? AND status="active"', [wishId, userId]);
  if (!wish) return res.status(404).json({ error: '愿望不存在或不可取消' });
  await queryRun("UPDATE wishes SET status='cancelled' WHERE id=?", [wishId]);
  res.json({ success: true });
});

// ================= 兑换 =================
app.post('/api/redeem', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { item, cost, wishId } = req.body;
  const pointRow = await queryOne('SELECT balance FROM points WHERE user_id=?', [userId]);
  if (!pointRow || pointRow.balance < cost) return res.status(400).json({ error: '积分不足' });
  if (item === '实现一个愿望') {
    if (!wishId) return res.status(400).json({ error: '请选择一个有效的愿望' });
    const wish = await queryOne('SELECT * FROM wishes WHERE id=? AND user_id=? AND status="active"', [wishId, userId]);
    if (!wish) return res.status(400).json({ error: '没有可兑换的愿望' });
    const newBalance = pointRow.balance - cost;
    await queryRun('UPDATE points SET balance = ? WHERE user_id = ?', [newBalance, userId]);
    await queryRun('INSERT INTO redemptions (user_id, item, points_spent, status) VALUES (?, ?, ?, ?)', [userId, `实现愿望：${wish.wish_text}`, cost, 'pending']);
    await queryRun("UPDATE wishes SET status='fulfilled' WHERE id=?", [wish.id]);
    return res.json({ success: true, newBalance });
  }
  const newBalance = pointRow.balance - cost;
  await queryRun('UPDATE points SET balance = ? WHERE user_id = ?', [newBalance, userId]);
  await queryRun('INSERT INTO redemptions (user_id, item, points_spent, status) VALUES (?, ?, ?, ?)', [userId, item, cost, 'pending']);
  res.json({ success: true, newBalance });
});

// 获取指定日期范围的打卡日期列表
app.get('/api/checkins/range', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { start, end } = req.query;
  const rows = await queryAll(
    'SELECT date FROM checkins WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date',
    [userId, start, end]
  );
  res.json({ dates: rows.map(r => r.date) });
});

// 获取已兑换愿望次数（用于里程碑）
app.get('/api/milestone/count', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const row = await queryOne(
    `SELECT COUNT(*) as count FROM redemptions 
     WHERE user_id = ? AND item LIKE '%实现愿望%'`,
    [userId]
  );
  res.json({ count: row?.count || 0 });
});

// ================= 用户旗帜 (Flag) 管理 =================

// 获取当前用户的所有未删除的 Flag（包括 active 和 completed，但排除 deleted）
app.get('/api/flags', authenticateToken, async (req, res) => {
  const userId = req.userId;
  try {
    // 确保 rawDb 已初始化
    const dbRaw = await initRawDb();
    const rows = await dbRaw.all(
      `SELECT id, type, content, status, created_at
       FROM user_flags 
       WHERE user_id = ? AND status != 'deleted'
       ORDER BY created_at DESC`,
      [userId]
    );
    console.log('✅ rawDb 查询到的 flags 数量:', rows.length);
    res.json({ flags: rows });
  } catch (err) {
    console.error('获取旗帜失败:', err);
    res.status(500).json({ error: '获取旗帜失败' });
  }
});

// 新增一个 Flag
app.post('/api/flags', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { type, content } = req.body;
  if (!type || !content) return res.status(400).json({ error: '类型和内容不能为空' });
  if (content.length > 200) return res.status(400).json({ error: '内容太长（最多200字符）' });
  try {
    const result = await queryRun(
      `INSERT INTO user_flags (user_id, type, content, status) 
       VALUES (?, ?, ?, 'active')`,
      [userId, type, content]
    );
    res.json({ success: true, flagId: result.lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

// 删除 Flag（软删除）
app.delete('/api/flags/:id', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const flagId = req.params.id;
  try {
    await queryRun(
      `UPDATE user_flags SET status = 'deleted' WHERE id = ? AND user_id = ?`,
      [flagId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 完成 Flag（标记为已完成）
app.post('/api/flags/:id/complete', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const flagId = req.params.id;
  try {
    await queryRun(
      `UPDATE user_flags SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
       WHERE id = ? AND user_id = ? AND status = 'active'`,
      [flagId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// ================= 修改密码 =================
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  const userId = req.userId;
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码都不能为空' });
  }
  if (newPassword.length < 3) {
    return res.status(400).json({ error: '新密码长度至少3位' });
  }
  // 验证旧密码
  const user = await queryOne('SELECT password FROM users WHERE id = ?', [userId]);
  if (!user || user.password !== oldPassword) {
    return res.status(400).json({ error: '旧密码错误' });
  }
  // 更新密码
  await queryRun('UPDATE users SET password = ? WHERE id = ?', [newPassword, userId]);
  res.json({ success: true });
});

// ================= 获取当前用户信息 =================
app.get('/api/user/info', authenticateToken, async (req, res) => {
  const userId = req.userId;
  // 注意：确保 users 表有 avatar 列，如果没有请先执行 SQL（见下方）
  const user = await queryOne('SELECT id, username, pushplus_token, avatar FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    username: user.username,
    avatar: user.avatar || '/images/default-avatar.png', // 默认头像
  });
});

// 上传头像
app.post('/api/user/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择图片文件' });
  }
  const userId = req.userId;
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  // 更新数据库（需先在 users 表增加 avatar 字段）
  await queryRun('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, userId]);
  res.json({ success: true, avatarUrl });
}, (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件太大，最大2MB' });
    }
  }
  res.status(400).json({ error: error.message });
});

// ================= 启动服务器 =================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动，端口：${PORT}`);
});