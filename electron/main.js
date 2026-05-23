const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let floatingWindow = null;
let mainWindow = null;

// 创建悬浮球窗口
function createFloatingWindow() {
  floatingWindow = new BrowserWindow({
    width: 80,
    height: 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  floatingWindow.loadFile(path.join(__dirname, 'floating.html'));
  floatingWindow.setIgnoreMouseEvents(false);
}

// 创建主窗口（打卡网页）
function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // 等待后端服务就绪（后端由 npm start 单独启动）
  const waitForBackend = () => {
    const net = require('net');
    const client = net.createConnection({ port: 8080 }, () => {
      client.destroy();
      mainWindow.loadURL('http://localhost:8080');
    });
    client.on('error', () => {
      setTimeout(waitForBackend, 500);
    });
  };
  waitForBackend();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC 事件
ipcMain.on('open-main-window', () => {
  createMainWindow();
});

ipcMain.handle('get-window-position', () => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    const [x, y] = floatingWindow.getPosition();
    return { x, y };
  }
  return { x: 0, y: 0 };
});

ipcMain.on('move-window', (event, x, y) => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.setPosition(x, y);
  }
});

// 应用启动：只创建悬浮球，后端由 npm start 负责
app.whenReady().then(() => {
  createFloatingWindow();
});

app.on('window-all-closed', () => {
  if (floatingWindow) return;
  if (process.platform !== 'darwin') app.quit();
});