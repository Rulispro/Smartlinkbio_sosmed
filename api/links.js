const GH = "https://api.github.com";

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
  } catch {
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
    throw new Error("Konfigurasi environment Vercel belum lengkap.");
  }
  return c;
}

function checkPassword(password) {
  const c = config();
  if (typeof password !== "string" || password !== c.password) {
    const error = new Error("Password Admin salah.");
    error.status = 401;
    throw error;
  }
}

async function getData() {
  const c = config();
  const url = fileUrl(c) + `?ref=${encodeURIComponent(c.branch)}`;
  const file = await gh(url);

  if (!file.content) {
    throw new Error("File data/links.json tidak memiliki content.");
  }

  const raw = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Isi data/links.json bukan JSON yang valid.");
  }

  if (!data.accounts) {
    data = {
      accounts: [
        {
          id: "default",
          name: "@utama",
          drafts: data.drafts || [],
          published: data.published || []
        }
      ]
    };
  }

  return { data, sha: file.sha };
}

async function saveData(data, sha) {
  const c = config();
  const content = Buffer.from(JSON.stringify(data, null, 2), "utf8").toString("base64");
  const url = fileUrl(c);

  return await gh(url, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update multi-account data",
      content,
      sha,
      branch: c.branch
    })
  });
}

export default async function handler(req, res) {
  try {
    checkConfig();

    if (req.method === "GET") {
      const { data } = await getData();
      const accountId = req.query.account || data.accounts[0]?.id;
      const account = data.accounts.find(a => a.id === accountId) || data.accounts[0];

      if (req.query.admin === "1") {
        checkPassword(req.headers["x-admin-password"]);
        return res.status(200).json({
          accounts: data.accounts,
          selectedAccount: account
        });
      }

      return res.status(200).json({
        published: account ? account.published : []
      });
    }

    if (req.method === "POST") {
      let body = req.body || {};
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch {
          return res.status(400).json({ error: "Request body bukan JSON valid." });
        }
      }

      checkPassword(body.password);
      const { data, sha } = await getData();

      // Tambah Akun Baru
      if (body.action === "addAccount") {
        const name = body.name ? body.name.trim() : "";
        if (!name) return res.status(400).json({ error: "Nama akun wajib diisi." });
        
        const newId = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
        if (data.accounts.some(a => a.id === newId)) {
          return res.status(400).json({ error: "Akun dengan ID tersebut sudah ada." });
        }

        data.accounts.push({
          id: newId,
          name: name.startsWith("@") ? name : "@" + name,
          drafts: [],
          published: []
        });

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Akun berhasil ditambahkan." });
      }

      // Hapus Akun
      if (body.action === "deleteAccount") {
        const targetId = body.accountId;
        if (data.accounts.length <= 1) {
          return res.status(400).json({ error: "Minimal harus ada satu akun aktif." });
        }

        const index = data.accounts.findIndex(a => a.id === targetId);
        if (index === -1) return res.status(404).json({ error: "Akun tidak ditemukan." });

        data.accounts.splice(index, 1);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Akun berhasil dihapus." });
      }

      const accountId = body.accountId;
      const account = data.accounts.find(a => a.id === accountId);
      if (!account) {
        return res.status(404).json({ error: "Akun tidak ditemukan." });
      }

      account.drafts = Array.isArray(account.drafts) ? account.drafts : [];
      account.published = Array.isArray(account.published) ? account.published : [];

      if (body.action === "saveDraft") {
        const p = body.item;
        if (!p || !p.title || !p.title.trim() || !Array.isArray(p.urls) || !p.urls.length) {
          return res.status(400).json({ error: "Data produk tidak valid." });
        }

        const urls = p.urls.map(u => String(u).trim()).filter(Boolean);
        const item = {
          id: p.id || crypto.randomUUID(),
          title: p.title.trim(),
          urls,
          updatedAt: new Date().toISOString()
        };

        const index = account.drafts.findIndex(x => x.id === item.id);
        if (index >= 0) account.drafts[index] = item;
        else account.drafts.push(item);

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Draft berhasil disimpan." });
      }

      if (body.action === "deleteDraft") {
        account.drafts = account.drafts.filter(x => x.id !== body.id);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Draft dihapus." });
      }

      if (body.action === "deletePublished") {
        account.published = account.published.filter(x => x.id !== body.id);
        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Produk published dihapus." });
      }

      if (body.action === "publishAll") {
        if (!account.drafts.length) return res.status(400).json({ error: "Tidak ada draft." });
        const now = new Date().toISOString();
        const publishedItems = account.drafts.map(item => ({ ...item, publishedAt: now }));
        account.published.push(...publishedItems);
        account.drafts = [];

        await saveData(data, sha);
        return res.status(200).json({ success: true, message: "Semua draft dipublikasikan." });
      }

      return res.status(400).json({ error: "Action tidak dikenal." });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method tidak diizinkan." });
  } catch (error) {
    console.error("API ERROR:", error);
    return res.status(error.status || 500).json({ error: error.message || "Kesalahan server." });
  }
}
