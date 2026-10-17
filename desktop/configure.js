// Writes builder.json for electron-builder from config.json (made by android/scripts/prepare.py).
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const run = String(process.env.RUN_NUMBER || '1').replace(/\D/g, '') || '1';
const slug = (process.env.EXE_NAME || 'app.exe').replace(/\.exe$/i, '').replace(/[^A-Za-z0-9-]/g, '') || 'app';
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
pkg.version = '1.0.' + run;
pkg.productName = cfg.name;
fs.writeFileSync(path.join(__dirname, 'package.json'), JSON.stringify(pkg, null, 2));
const builder = {
  appId: cfg.appId,
  productName: cfg.name,
  copyright: cfg.name,
  directories: { output: 'dist' },
  files: ['main.js', 'preload.js', 'lock.html', 'config.json', 'icon.png', 'site/**/*'],
  icon: 'icon.png',
  win: { target: [{ target: 'portable', arch: ['x64'] }], icon: 'icon.png' },
  portable: { artifactName: slug + '.exe' },
  compression: 'maximum',
  asar: true,
};
fs.writeFileSync(path.join(__dirname, 'builder.json'), JSON.stringify(builder, null, 2));
console.log('configured', cfg.name, pkg.version, slug + '.exe');
