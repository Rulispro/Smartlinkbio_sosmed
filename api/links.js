const GH = "https://api.github.com";

// Helper untuk generate ID sederhana jika crypto.randomUUID tidak tersedia
function generateSimpleId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function config() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main",
    password: process.env.ADMIN_PASSWORD
  };
}

function fileUrl(c) {
  // Pastikan path ke data/links.json benar di repo Anda
  return `${GH}/repos/${c.owner}/${c.repo}/contents/data/links.json`;
}

async function gh(url, options = {}) {
  const c = config();
  const r = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${c.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { message: text };
  }

  if (!r.ok) {
    const error = new Error(data.message || `GitHub error ${r.status}`);
    error.status = r.status;
    throw error;
  }
  return data;
}

function checkConfig() {
  const c = config();
  if (!c.token || !c.owner || !c.repo || !c.password) {
    throw new Error("Konfigurasi environment Vercel belum lengkap (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ADMIN_PASSWORD).");
  }
  return c;
}

function checkPassword(password, correctPassword) {
  if (!password || typeof password !== "string" || password !== correctPassword) {
    const error = new Error("Password Admin salah atau tidak disertakan.");
    error.status = 401;
    throw error;
  }
}

async function getData() {
  const c = config();
  const url = fileUrl(c) + `?ref=${encodeURIComponent(c.branch)}`;
  
  try {
    const file = await gh(url);

    if (!file.content) {
      throw new Error("File data/links.json tidak memiliki content.");
    }

    const raw = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error("Isi data/links.json bukan JSON yang valid.");
    }

    // Migrasi data lama/struktur baru
    if (!data.accounts || !Array.isArray(data.accounts)) {
      // Jika data kosong, inisialisasi array kosong
      if (!data.drafts && !data.published) {
          data = { accounts: [] };
      } else {
          // Migrasi dari format single account lama
          data = {
            accounts: [
              {
                id: "default",
                name: "@utama",
                drafts: Array.isArray(data.drafts) ? data.drafts : [],
                published: Array.isArray(data.published) ? data.published : []
              }
            ]
          };
      }
    }

    return { data, sha: file.sha };
  } catch (e) {
    if (e.status === 404) {
      // Jika file belum ada di GitHub, kembalikan struktur kosong (tanpa SHA)
      return { data: { accounts: [] }, sha: null };
    }
    throw e;
  }
}

async function saveData(data, sha) {
  const c = config();
  const content = Buffer.from(JSON.stringify(data, null, 2), "utf8").toString("base64");
  const url = fileUrl(c);

  const body = {
    message: "Update multi-account data via Admin Panel",
    content,
    branch: c.branch
  };

  // Jika SHA ada (update), sertakan. Jika null (file baru), jangan sertakan.
  if (sha) body.sha = sha;

  return await gh(url, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  // Tambahkan Header CORS jika diperlukan untuk development lokal
  // res.setHeader('Access-Control-Allow-Origin', '*');
  // res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const c = checkConfig();

    if (req.method === "GET") {
      const { data } = await getData();

      // Mode Admin: Minta semua akun
      if (req.query.admin === "1") {
        checkPassword(req.headers["x-admin-password"], c.password);
        return res.status(200).json({
          accounts: data.accounts
        });
      }

      // Mode Publik: Minta link untuk 1 akun tertentu
      const accountId = req.query.account;
      if (!accountId) {
          return res.status(400).json({ error: "Query parameter 'account' (ID Akun) diperlukan." });
      }
      
      const account = data.accounts.find(a => a.id === accountId);
      if (!account) {
        return res.status(404).json({ error: "Akun tidak ditemukan." });
      }

      return res.status(200).json({
        name: account.name,
        published: account.published || []
      });
    }

    if (req.method === "POST") {
      let body = req.body || {};
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) {
          return res.status(400).json({ error: "Request body bukan JSON valid." });
        }
      }

      checkPassword(body.password, c.password);
      const { data, sha } = await getData();

      // --- Aksi Level Global (Tanpa butuh accountId yang ada) ---

      // Tambah Akun Baru
      if (body.action === "addAccount") {
        const name = body.name ? body.name.trim() : "";
        if (!name) return res.status(400).json({ error: "Nama akun wajib diisi." });
        
        // Generate ID dari nama: "Suka Suka" -> "suka_suka"
        let newId = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/__+/g, "_");
        
        // Pastikan ID unik, jika bentrok tambah suffix random
        if (data.accounts.some(a => a.id === newId)) {
           newId = newId + "_" + Math.random().toString(36).substring(2, 5);
        }

        data.accounts.push({
          id: newId,
          name: name.startsWith("@") ? name : "@" + name,
          drafts: [],
          published: []
        });

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Akun berhasil ditambahkan.", accountId: newId });
      }

      // Hapus Akun
      if (body.action === "deleteAccount") {
        const targetId = body.accountId;
        if (!targetId) return res.status(400).json({ error: "ID Akun yang akan dihapus diperlukan." });

        const index = data.accounts.findIndex(a => a.id === targetId);
        if (index === -1) return res.status(404).json({ error: "Akun tidak ditemukan." });

        data.accounts.splice(index, 1);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Akun berhasil dihapus." });
      }

      // --- Aksi Level Akun (Butuh accountId yang valid) ---
      
      const accountId = body.accountId;
      if (!accountId) return res.status(400).json({ error: "Aksi ini memerlukan ID Akun (accountId)." });
      
      const account = data.accounts.find(a => a.id === accountId);
      if (!account) {
        return res.status(404).json({ error: "Akun aktif tidak ditemukan dalam database." });
      }

      // Pastikan array ada
      account.drafts = Array.isArray(account.drafts) ? account.drafts : [];
      account.published = Array.isArray(account.published) ? account.published : [];

      if (body.action === "saveDraft") {
        const p = body.item;
        if (!p || !p.title || !p.title.trim() || !Array.isArray(p.urls) || !p.urls.length) {
          return res.status(400).json({ error: "Data produk tidak valid (Judul dan URLs diperlukan)." });
        }

        const urls = p.urls.map(u => String(u).trim()).filter(Boolean);
        const item = {
          // Gunakan ID yang dikirim (untuk edit) atau generate baru (aman)
          id: p.id && p.id.length > 10 ? p.id : generateSimpleId(), 
          title: p.title.trim(),
          urls,
          updatedAt: new Date().toISOString()
        };

        const index = account.drafts.findIndex(x => x.id === item.id);
        if (index >= 0) account.drafts[index] = item; // Edit
        else account.drafts.push(item); // Tambah Baru

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Draft berhasil disimpan." });
      }

      if (body.action === "deleteDraft") {
        if (!body.id) return res.status(400).json({ error: "ID Draft diperlukan." });
        account.drafts = account.drafts.filter(x => x.id !== body.id);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Draft dihapus." });
      }

      if (body.action === "deletePublished") {
        if (!body.id) return res.status(400).json({ error: "ID Produk diperlukan." });
        account.published = account.published.filter(x => x.id !== body.id);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Produk published dihapus." });
      }

      if (body.action === "publishAll") {
        if (!account.drafts.length) return res.status(400).json({ error: "Tidak ada draft untuk dipublikasikan." });
        const now = new Date().toISOString();
        // Tambahkan properti publishedAt
        const publishedItems = account.drafts.map(item => ({ ...item, publishedAt: now }));
        
        // Pindahkan ke array published
        account.published.push(...publishedItems);
        // Kosongkan draft
        account.drafts = [];

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Semua draft berhasil dipublikasikan." });
      }

      return res.status(400).json({ error: "Action tidak dikenal." });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: `Method ${req.method} tidak diizinkan.` });
  } catch (error) {
    console.error("API ERROR:", error);
    // Pastikan mengirim response JSON saat error
    return res.status(error.status || 500).json({ 
        error: error.message || "Kesalahan server internal.",
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
