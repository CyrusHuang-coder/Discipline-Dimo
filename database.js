const sqlite3 = require('sqlite3');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const db = new sqlite3.Database('./data.db');

// ---------- 辅助函数：将 callback 风格的 sqlite3 方法转为 Promise ----------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ---------- 初始化所有表 ----------
async function initializeDB() {
  // 1. 用户表
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(50) NOT NULL,
      pushplus_token VARCHAR(255) DEFAULT NULL
    )
  `);

  // 2. 打卡记录表
  await run(`
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      UNIQUE(user_id, date)
    )
  `);

  // 3. 提醒记录表
  await run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, date)
    )
  `);

  // 4. 积分表
  await run(`
    CREATE TABLE IF NOT EXISTS points (
      user_id INT PRIMARY KEY,
      balance INT DEFAULT 0
    )
  `);

  // 5. 兑换记录表
  await run(`
    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT NOT NULL,
      item VARCHAR(50) NOT NULL,
      points_spent INT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 6. 愿望表
  await run(`
    CREATE TABLE IF NOT EXISTS wishes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT NOT NULL,
      wish_text VARCHAR(200) NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 7. 用户旗帜表（flag）
  await run(`
    CREATE TABLE IF NOT EXISTS user_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INT NOT NULL,
      type VARCHAR(20) NOT NULL,
      content VARCHAR(200) NOT NULL,
      encouragement VARCHAR(200),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

// ---------- 包装成类似 MySQL 的 execute 接口（用于 server.js） ----------
const wrappedDb = {
  execute: async (sql, params = []) => {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      if (sql.includes('LIMIT 1') || trimmed.includes('= ?') || trimmed.includes('=?')) {
        const row = await get(sql, params);
        return [row];
      } else {
        const rows = await all(sql, params);
        return [rows];
      }
    } else {
      const result = await run(sql, params);
      return [result];
    }
  },
  getConnection: async () => {
    return {
      execute: wrappedDb.execute,
      release: () => {}
    };
  }
};

// 启动初始化
initializeDB().catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});

// 导出 wrappedDb 作为默认，同时导出 all, get, run 以便 server.js 直接使用
module.exports = wrappedDb;
module.exports.all = all;
module.exports.get = get;
module.exports.run = run;