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
    const error = new Error(
      data.message || `GitHub error ${r.status}`
    );

    error.status = r.status;
    throw error;
  }

  return data;
}

function checkConfig() {
  const c = config();

  if (!c.token) {
    throw new Error("GITHUB_TOKEN belum diatur di Vercel.");
  }

  if (!c.owner) {
    throw new Error("GITHUB_OWNER belum diatur di Vercel.");
  }

  if (!c.repo) {
    throw new Error("GITHUB_REPO belum diatur di Vercel.");
  }

  if (!c.password) {
    throw new Error("ADMIN_PASSWORD belum diatur di Vercel.");
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

  // PENTING:
  // URL dibuat langsung di sini, bukan menggunakan teks literal ${fileUrl(c)}
  const url =
    fileUrl(c) +
    `?ref=${encodeURIComponent(c.branch)}`;

  const file = await gh(url);

  if (!file.content) {
    throw new Error("File data/links.json tidak memiliki content.");
  }

  const raw = Buffer.from(
    file.content.replace(/\n/g, ""),
    "base64"
  ).toString("utf8");

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Isi data/links.json bukan JSON yang valid."
    );
  }

  return {
    data,
    sha: file.sha
  };
}

async function saveData(data, sha) {
  const c = config();

  const content = Buffer.from(
    JSON.stringify(data, null, 2),
    "utf8"
  ).toString("base64");

  const url = fileUrl(c);

  return await gh(url, {
    method: "PUT",

    body: JSON.stringify({
      message: "Update affiliate links",
      content,
      sha,
      branch: c.branch
    })
  });
}

export default async function handler(req, res) {
  try {
    checkConfig();

    // =========================
    // GET
    // =========================
    if (req.method === "GET") {
      const { data } = await getData();

      const drafts = Array.isArray(data.drafts)
        ? data.drafts
        : [];

      const published = Array.isArray(data.published)
        ? data.published
        : [];

      // Admin
      if (req.query.admin === "1") {
        checkPassword(
          req.headers["x-admin-password"]
        );

        return res.status(200).json({
          drafts,
          published
        });
      }

      // Public
      return res.status(200).json({
        published
      });
    }

    // =========================
    // POST
    // =========================
    if (req.method === "POST") {
      let body = req.body || {};

      // Kadang Vercel menerima body sebagai string
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          return res.status(400).json({
            error: "Request body bukan JSON yang valid."
          });
        }
      }

      checkPassword(body.password);

      const { data, sha } = await getData();

      data.drafts = Array.isArray(data.drafts)
        ? data.drafts
        : [];

      data.published = Array.isArray(data.published)
        ? data.published
        : [];

      // =========================
      // SAVE DRAFT
      // =========================
      if (body.action === "saveDraft") {
        const p = body.item;

        if (
          !p ||
          typeof p.id !== "string" ||
          typeof p.title !== "string" ||
          !p.title.trim() ||
          !Array.isArray(p.urls) ||
          !p.urls.length
        ) {
          return res.status(400).json({
            error: "Data produk tidak valid."
          });
        }

        const urls = p.urls
          .map(u => String(u).trim())
          .filter(Boolean);

        if (!urls.length) {
          return res.status(400).json({
            error: "Minimal satu link diperlukan."
          });
        }

        for (const url of urls) {
          if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({
              error: `URL tidak valid: ${url}`
            });
          }
        }

        const item = {
          id: p.id,
          title: p.title.trim(),
          urls,
          updatedAt: new Date().toISOString()
        };

        const index = data.drafts.findIndex(
          x => x.id === item.id
        );

        if (index >= 0) {
          data.drafts[index] = item;
        } else {
          data.drafts.push(item);
        }

        await saveData(data, sha);

        return res.status(200).json({
          success: true,
          message: "Draft berhasil disimpan."
        });
      }

      // =========================
      // DELETE DRAFT
      // =========================
      if (body.action === "deleteDraft") {
        if (typeof body.id !== "string") {
          return res.status(400).json({
            error: "ID draft tidak valid."
          });
        }

        const before = data.drafts.length;

        data.drafts = data.drafts.filter(
          x => x.id !== body.id
        );

        if (data.drafts.length === before) {
          return res.status(404).json({
            error: "Draft tidak ditemukan."
          });
        }

        await saveData(data, sha);

        return res.status(200).json({
          success: true,
          message: "Draft berhasil dihapus."
        });
      }

      // =========================
      // DELETE PUBLISHED
      // =========================
      if (body.action === "deletePublished") {
        if (typeof body.id !== "string") {
          return res.status(400).json({
            error: "ID produk tidak valid."
          });
        }

        const before = data.published.length;

        data.published = data.published.filter(
          x => x.id !== body.id
        );

        if (data.published.length === before) {
          return res.status(404).json({
            error: "Produk published tidak ditemukan."
          });
        }

        await saveData(data, sha);

        return res.status(200).json({
          success: true,
          message: "Produk berhasil dihapus."
        });
      }

      // =========================
      // PUBLISH ALL
      // =========================
      if (body.action === "publishAll") {
        if (!data.drafts.length) {
          return res.status(400).json({
            error: "Tidak ada draft untuk dipublish."
          });
        }

        const now = new Date().toISOString();

        const publishedItems = data.drafts.map(item => ({
          ...item,
          publishedAt: now
        }));

        data.published.push(
          ...publishedItems
        );

        data.drafts = [];

        await saveData(data, sha);

        return res.status(200).json({
          success: true,
          message: "Semua draft berhasil dipublish."
        });
      }

      return res.status(400).json({
        error: "Action tidak dikenal."
      });
    }

    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res.status(405).json({
      error: "Method tidak diizinkan."
    });

  } catch (error) {
    console.error("API ERROR:", error);

    return res.status(
      error.status || 500
    ).json({
      error:
        error.message ||
        "Terjadi kesalahan server."
    });
  }
}
