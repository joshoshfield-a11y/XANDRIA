/** Xandria Studio — Electron shell. */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0d14',
    title: 'Xandria Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../dist/index.html'));
}

ipcMain.handle('xandria:saveFile', async (_evt, name, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: name,
    filters: [{ name: 'HTML Game', extensions: ['html'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
