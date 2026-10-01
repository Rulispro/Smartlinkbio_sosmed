const GH = "https://api.github.com";

function config(){
return {
token: process.env.GITHUB_TOKEN,
owner: process.env.GITHUB_OWNER,
repo: process.env.GITHUB_REPO,
branch: process.env.GITHUB_BRANCH || "main",
password: process.env.ADMIN_PASSWORD
};
}

function checkConfig(){
const c = config();

if(
!c.token ||
!c.owner ||
!c.repo ||
!c.password
){
throw new Error(
"Environment Variables Vercel belum lengkap."
);
}

return c;
}

async function gh(url, options = {}){

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

const body = await r.text();

let data = {};

try{
data = body ? JSON.parse(body) : {};
}catch{
data = {
message: body
};
}

if(!r.ok){

let msg =
  data.message ||
  `GitHub error ${r.status}`;

if(r.status === 401){
  msg =
    "GitHub Token tidak valid atau sudah kedaluwarsa.";
}

if(r.status === 403){
  msg =
    "GitHub menolak akses. Pastikan Fine-grained Token memiliki Contents: Read and write pada repository Smartlinkbio_sosmed.";
}

if(r.status === 404){
  msg =
    "Repository atau file data/links.json tidak ditemukan. Cek GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH dan lokasi file.";
}

if(r.status === 409){
  msg =
    "GitHub mengalami konflik saat menyimpan links.json. Coba lagi.";
}

const error = new Error(msg);

error.status = r.status;

throw error;

}

return data;
}

function checkPassword(p){

const c = config();

if(
typeof p !== "string" ||
p !== c.password
){

const e =
  new Error("Password admin salah.");

e.status = 401;

throw e;

}
}

function fileUrl(c){

return "${GH}/repos/${c.owner}/${c.repo}/contents/data/links.json";

}

async function getData(){

const c = config();

const file = await gh(
"${fileUrl(c)}?ref=${encodeURIComponent(c.branch)}"
);

if(!file.content){

throw new Error(
  "Isi data/links.json tidak ditemukan."
);

}

const raw =
Buffer
.from(
file.content.replace(/\n/g, ""),
"base64"
)
.toString("utf8");

let data;

try{

data = JSON.parse(raw);

}catch{

throw new Error(
  "data/links.json bukan JSON yang valid."
);

}

return {
data,
sha: file.sha
};

}

async function saveData(data, sha){

const c = config();

const content =
Buffer
.from(
JSON.stringify(data, null, 2),
"utf8"
)
.toString("base64");

return gh(
fileUrl(c),
{
method: "PUT",

  body: JSON.stringify({

    message: "Update affiliate links",

    content,

    sha,

    branch: c.branch

  })
}

);

}

export default async function handler(req, res){

try{

checkConfig();


/* =========================
   GET
   ========================= */

if(req.method === "GET"){

  const { data } = await getData();


  data.drafts =
    Array.isArray(data.drafts)
    ? data.drafts
    : [];


  data.published =
    Array.isArray(data.published)
    ? data.published
    : [];


  if(req.query.admin === "1"){

    checkPassword(
      req.headers["x-admin-password"]
    );


    return res.status(200).json({

      drafts: data.drafts,

      published: data.published

    });

  }


  return res.status(200).json({

    published: data.published

  });

}


/* =========================
   POST
   ========================= */

if(req.method !== "POST"){

  res.setHeader(
    "Allow",
    "GET, POST"
  );

  return res.status(405).json({
    error: "Method tidak diizinkan."
  });

}


let body = req.body || {};


/*
  Beberapa environment Vercel
  dapat memberikan body sebagai string.
*/

if(typeof body === "string"){

  try{

    body = JSON.parse(body);

  }catch{

    return res.status(400).json({
      error: "Request JSON tidak valid."
    });

  }

}


checkPassword(body.password);


const { data, sha } =
  await getData();


data.drafts =
  Array.isArray(data.drafts)
  ? data.drafts
  : [];


data.published =
  Array.isArray(data.published)
  ? data.published
  : [];


/* =========================
   SAVE DRAFT
   ========================= */

if(body.action === "saveDraft"){

  const p = body.item;


  if(
    !p ||
    typeof p.id !== "string" ||
    typeof p.title !== "string" ||
    !p.title.trim() ||
    !Array.isArray(p.urls) ||
    !p.urls.length ||
    p.urls.some(
      u =>
        typeof u !== "string" ||
        !/^https?:\/\//i.test(u)
    )
  ){

    return res.status(400).json({
      error: "Data produk atau URL tidak valid."
    });

  }


  const item = {

    id: p.id,

    title: p.title.trim(),

    urls: p.urls
      .map(u => u.trim())
      .filter(Boolean),

    updatedAt:
      new Date().toISOString()

  };


  const index =
    data.drafts.findIndex(
      x => x.id === item.id
    );


  if(index >= 0)
    data.drafts[index] = item;
  else
    data.drafts.push(item);


  await saveData(data, sha);


  return res.status(200).json({
    success: true
  });

}


/* =========================
   DELETE DRAFT
   ========================= */

if(body.action === "deleteDraft"){

  if(typeof body.id !== "string"){

    return res.status(400).json({
      error: "ID draft tidak valid."
    });

  }


  const oldLength =
    data.drafts.length;


  data.drafts =
    data.drafts.filter(
      x => x.id !== body.id
    );


  if(data.drafts.length === oldLength){

    return res.status(404).json({
      error: "Draft tidak ditemukan."
    });

  }


  await saveData(data, sha);


  return res.status(200).json({
    success: true
  });

}


/* =========================
   PUBLISH ALL
   ========================= */

if(body.action === "publishAll"){

  if(!data.drafts.length){

    return res.status(400).json({
      error: "Tidak ada draft."
    });

  }


  const now =
    new Date().toISOString();


  data.published.push(
    ...data.drafts.map(
      p => ({
        ...p,
        publishedAt: now
      })
    )
  );


  data.drafts = [];


  await saveData(data, sha);


  return res.status(200).json({
    success: true
  });

}


/* =========================
   DELETE PUBLISHED
   ========================= */

if(body.action === "deletePublished"){

  if(typeof body.id !== "string"){

    return res.status(400).json({
      error: "ID published tidak valid."
    });

  }


  const oldLength =
    data.published.length;


  data.published =
    data.published.filter(
      x => x.id !== body.id
    );


  if(
    data.published.length === oldLength
  ){

    return res.status(404).json({
      error: "Produk published tidak ditemukan."
    });

  }


  await saveData(data, sha);


  return res.status(200).json({
    success: true
  });

}


return res.status(400).json({
  error: "Action tidak dikenal."
});

}catch(e){

console.error(e);

return res
  .status(e.status || 500)
  .json({
    error:
      e.message ||
      "Terjadi kesalahan server."
  });

}

}
