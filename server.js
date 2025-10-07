const express = require('express');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());
app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: true,
}));

// Single user
const USERS = {
  e: 'e',
  Darktech: '1142E',

};

// Helper: resolve and sanitize a user-relative path
function resolveUserPath(user, relPath = '') {
  // Normalize to prevent weird ../ sequences
  const normalized = path.posix.normalize('/' + relPath).replace(/^\//, ''); // remove leading slash
  if (normalized.includes('..')) throw new Error('Invalid path');
  const base = path.join(__dirname, 'uploads', user);
  const full = path.join(base, normalized);
  // Ensure the resulting path is still inside user's folder
  const resolvedBase = path.resolve(base) + path.sep;
  const resolvedFull = path.resolve(full) + (fs.existsSync(full) && fs.lstatSync(full).isDirectory() ? path.sep : '');
  if (!resolvedFull.startsWith(resolvedBase) && path.resolve(full) !== path.resolve(base)) {
    throw new Error('Invalid path (escape attempt)');
  }
  return full;
}

// Ensure uploads and user folder exist
function ensureUserDir(user) {
  const base = path.join(__dirname, 'uploads', user);
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
}

// Login route
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.redirect('/index.html');
  }
  res.send('Invalid credentials. <a href="/login.html">Try again</a>. Dumbass');
});

// Auth middleware
function auth(req, res, next) {
  if (!req.session.user) return res.redirect('/login.html');
  next();
}

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/login.html');
  });
});

// List contents of a folder
// GET /list?path=some/subfolder
app.get('/list', auth, (req, res) => {
  const user = req.session.user;
  const rel = req.query.path || '';
  try {
    ensureUserDir(user);
    const dir = resolveUserPath(user, rel);
    if (!fs.existsSync(dir)) return res.json({ user, path: rel, folders: [], files: [] });

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) folders.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
    res.json({ user, path: rel, folders, files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create folder
// POST /create-folder  body: path, name
app.post('/create-folder', auth, (req, res) => {
  const user = req.session.user;
  const { path: rel = '', name } = req.body;
  if (!name) return res.status(400).send('Missing folder name');
  try {
    ensureUserDir(user);
    const parent = resolveUserPath(user, rel);
    const newDir = path.join(parent, name);
    if (newDir.includes('..')) throw new Error('Invalid folder name');
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    res.redirect('/index.html');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Delete folder (recursive)
// POST /delete-folder  body: path, name
app.post('/delete-folder', auth, (req, res) => {
  const user = req.session.user;
  const { path: rel = '', name } = req.body;
  if (!name) return res.status(400).send('Missing folder name');
  try {
    ensureUserDir(user);
    const parent = resolveUserPath(user, rel);
    const target = path.join(parent, name);
    const resolved = path.resolve(target);
    const base = path.resolve(path.join(__dirname, 'uploads', user));
    if (!resolved.startsWith(base)) throw new Error('Invalid path');
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    res.redirect('/index.html');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Rename folder
// POST /rename-folder body: path, oldName, newName
app.post('/rename-folder', auth, (req, res) => {
  const user = req.session.user;
  const { path: rel = '', oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).send('Missing names');
  try {
    ensureUserDir(user);
    const parent = resolveUserPath(user, rel);
    const oldPath = path.join(parent, oldName);
    const newPath = path.join(parent, newName);
    if (!fs.existsSync(oldPath)) return res.status(404).send('Folder not found');
    if (fs.existsSync(newPath)) return res.status(400).send('Target folder already exists');
    fs.renameSync(oldPath, newPath);
    res.redirect('/index.html');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Upload file into a path (optional)
// POST /upload (multipart) fields: file, path
app.post('/upload', auth, (req, res) => {
  const user = req.session.user;
  const rel = req.body.path || '';
  if (!req.files || !req.files.file) return res.status(400).send('No file uploaded');
  try {
    ensureUserDir(user);
    const dir = resolveUserPath(user, rel);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = req.files.file;
    const dst = path.join(dir, file.name);
    file.mv(dst, err => {
      if (err) return res.status(500).send('Upload error: ' + err.message);
      res.redirect('/index.html');
    });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Download file
// GET /download?path=some/sub&filename=foo.txt
app.get('/download', auth, (req, res) => {
  const user = req.session.user;
  const rel = req.query.path || '';
  const filename = req.query.filename;
  if (!filename) return res.status(400).send('Missing filename');
  try {
    ensureUserDir(user);
    const dir = resolveUserPath(user, rel);
    const filePath = path.join(dir, filename);
    const resolved = path.resolve(filePath);
    const base = path.resolve(path.join(__dirname, 'uploads', user));
    if (!resolved.startsWith(base)) throw new Error('Invalid path');
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.download(filePath);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Delete file
// POST /delete-file body: path, filename
app.post('/delete-file', auth, (req, res) => {
  const user = req.session.user;
  const { path: rel = '', filename } = req.body;
  if (!filename) return res.status(400).send('Missing filename');
  try {
    ensureUserDir(user);
    const dir = resolveUserPath(user, rel);
    const filePath = path.join(dir, filename);
    const resolved = path.resolve(filePath);
    const base = path.resolve(path.join(__dirname, 'uploads', user));
    if (!resolved.startsWith(base)) throw new Error('Invalid path');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.redirect('/index.html');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Rename file
// POST /rename-file body: path, oldName, newName
app.post('/rename-file', auth, (req, res) => {
  const user = req.session.user;
  const { path: rel = '', oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).send('Missing names');
  try {
    ensureUserDir(user);
    const dir = resolveUserPath(user, rel);
    const oldPath = path.join(dir, oldName);
    const newPath = path.join(dir, newName);
    const base = path.resolve(path.join(__dirname, 'uploads', user));
    if (!path.resolve(oldPath).startsWith(base) || !path.resolve(newPath).startsWith(base)) {
      throw new Error('Invalid path');
    }
    if (!fs.existsSync(oldPath)) return res.status(404).send('File not found');
    if (fs.existsSync(newPath)) return res.status(400).send('Target filename already exists');
    fs.renameSync(oldPath, newPath);
    res.redirect('/index.html');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
