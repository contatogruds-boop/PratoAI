import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(root, "generated");
const dataDir = path.join(root, "data");
const menusFile = path.join(dataDir, "menus.json");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
    cb(allowed.has(file.mimetype) ? null : new Error("Envie uma imagem JPG, PNG, WebP ou um PDF."), allowed.has(file.mimetype));
  }
});

const menuSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    restaurant_name: { type: "string", description: "Nome do restaurante, se estiver legível; string vazia caso contrário." },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "Descrição transcrita do cardápio. String vazia se não houver." },
          price_text: { type: "string", description: "Preço exatamente como aparece, ou Preço não identificado." },
          category: { type: "string", description: "Categoria do cardápio, se identificável." },
          image_prompt: { type: "string", description: "Prompt curto para uma foto apetitosa e realista deste prato, sem texto na imagem." }
        },
        required: ["name", "description", "price_text", "category", "image_prompt"]
      }
    }
  },
  required: ["restaurant_name", "items"]
};

function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function apiFailure(scope, error, fallback) {
  const status = error?.status;
  const code = error?.code || error?.error?.code;
  if (status || code) {
    console.error(`${scope}: HTTP ${status || "?"}${code ? ` (${code})` : ""}`);
  } else {
    console.error(`${scope}: ${error?.name || "Error"}: ${error?.message || "erro desconhecido"}`);
  }

  if (status === 401 || code === "invalid_api_key") {
    return { status: 401, message: "A OpenAI recusou a chave configurada. Confira OPENAI_API_KEY no arquivo .env, salve e reinicie o servidor." };
  }
  if (status === 429) {
    return { status: 429, message: "A API recusou a solicitação por limite ou saldo. Confira uso e cobrança na OpenAI Platform." };
  }
  return { status: 502, message: fallback };
}

app.use(express.json({ limit: "32kb" }));
app.get("/", (_req, res) => res.sendFile(path.join(root, "index.html")));
app.use("/generated", express.static(generatedDir, { fallthrough: false, maxAge: "1d" }));

async function readMenus() {
  try {
    return JSON.parse(await readFile(menusFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
}

app.post("/api/publish-menu", async (req, res) => {
  const source = req.body?.menu;
  if (!source || !Array.isArray(source.items) || !source.items.length || source.items.length > 30) {
    return res.status(400).json({ error: "O cardápio precisa ter entre 1 e 30 pratos." });
  }
  const restaurantName = String(source.restaurant_name || "").trim().slice(0, 100);
  if (!restaurantName) return res.status(400).json({ error: "Informe o nome do restaurante." });

  const slug = randomUUID();
  const menu = {
    slug,
    restaurant_name: restaurantName,
    created_at: new Date().toISOString(),
    items: source.items.map((item) => ({
      name: String(item.name || "Prato").trim().slice(0, 140),
      description: String(item.description || "").trim().slice(0, 300),
      price_text: String(item.price_text || "Preço não informado").trim().slice(0, 60),
      category: String(item.category || "Cardápio").trim().slice(0, 80),
      image_url: /^\/generated\/[a-f0-9-]+\.png$/i.test(String(item.image_url || "")) ? item.image_url : ""
    }))
  };

  try {
    await mkdir(dataDir, { recursive: true });
    const menus = await readMenus();
    menus[slug] = menu;
    const tempFile = `${menusFile}.tmp`;
    await writeFile(tempFile, JSON.stringify(menus, null, 2), "utf8");
    await rename(tempFile, menusFile);

    const configuredBase = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    const origin = configuredBase || `${req.protocol}://${req.get("host")}`;
    const url = `${origin}/m/${slug}`;
    const qrCode = await QRCode.toDataURL(url, { errorCorrectionLevel: "H", width: 520, margin: 2 });
    res.json({ slug, url, qr_code: qrCode });
  } catch (error) {
    console.error("Falha ao publicar o cardápio:", error?.message || "erro desconhecido");
    res.status(500).json({ error: "Não foi possível publicar o cardápio. Tente novamente." });
  }
});

app.get("/m/:slug", async (req, res) => {
  if (!/^[a-f0-9-]{36}$/i.test(req.params.slug)) return res.status(404).send("Cardápio não encontrado.");
  try {
    const menus = await readMenus();
    const menu = menus[req.params.slug];
    if (!menu) return res.status(404).send("Cardápio não encontrado.");
    const groups = new Map();
    for (const item of menu.items) {
      const category = item.category || "Cardápio";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    const sections = [...groups.entries()].map(([category, items]) => `
      <section class="category"><h2>${escapeHtml(category)}</h2><div class="grid">${items.map((item) => `
        <article class="dish">${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="Foto de ${escapeHtml(item.name)}" loading="lazy">` : ""}
          <div class="dish-copy"><h3>${escapeHtml(item.name)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}<strong>${escapeHtml(item.price_text)}</strong></div>
        </article>`).join("")}</div></section>`).join("");
    res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#18231c"><title>${escapeHtml(menu.restaurant_name)} — Cardápio</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f7f5ef;color:#20281f;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.hero{background:#18231c;color:#f7f5ef;padding:50px 24px 44px;text-align:center}.brand{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c5f277;font-weight:700}.hero h1{font:600 clamp(34px,6vw,52px)/1.1 Georgia,serif;margin:14px 0 8px}.hero p{color:#b5c1b5;margin:0}.content{width:min(900px,calc(100% - 36px));margin:40px auto 70px}.category{margin:0 0 36px}.category h2{font:600 28px Georgia,serif;margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(265px,1fr));gap:14px}.dish{background:white;border:1px solid #ebe9e1;border-radius:13px;overflow:hidden;display:grid;grid-template-columns:110px 1fr;min-height:130px}.dish img{width:110px;height:100%;min-height:130px;object-fit:cover}.dish-copy{padding:16px;display:flex;flex-direction:column;align-items:flex-start}.dish h3{font-size:16px;line-height:1.25;margin:0 0 6px}.dish p{color:#69746a;font-size:13px;margin:0 0 10px}.dish strong{color:#38542a;margin-top:auto}.footer{text-align:center;color:#7e897f;font-size:12px;padding:24px;border-top:1px solid #e8e6de}@media(max-width:430px){.dish{grid-template-columns:90px 1fr}.dish img{width:90px}}
      </style></head><body><header class="hero"><div class="brand">✳ prato.</div><h1>${escapeHtml(menu.restaurant_name)}</h1><p>Cardápio digital</p></header><main class="content">${sections}</main><footer class="footer">Cardápio digital · Feito com Prato</footer></body></html>`);
  } catch (error) {
    console.error("Falha ao abrir o cardápio:", error?.message || "erro desconhecido");
    res.status(500).send("Não foi possível carregar este cardápio.");
  }
});

app.post("/api/process-menu", upload.single("menu"), async (req, res) => {
  const client = getClient();
  if (!client) return res.status(503).json({ error: "Configure a chave OPENAI_API_KEY no arquivo .env e reinicie o servidor." });
  if (!req.file) return res.status(400).json({ error: "Escolha uma foto ou um PDF do cardápio." });

  try {
    const base64 = req.file.buffer.toString("base64");
    const visualInput = req.file.mimetype === "application/pdf"
      ? { type: "input_file", filename: req.file.originalname || "cardapio.pdf", file_data: `data:application/pdf;base64,${base64}`, detail: "high" }
      : { type: "input_image", image_url: `data:${req.file.mimetype};base64,${base64}`, detail: "high" };

    const response = await client.responses.create({
      model: process.env.OPENAI_VISION_MODEL || "gpt-6-astra",
      input: [{
        role: "user",
        content: [
          visualInput,
          { type: "input_text", text: "Leia este cardápio em português. Transcreva somente os pratos e os preços visíveis. Não invente nomes, ingredientes, descrições nem preços. Se o preço estiver ilegível, escreva 'Preço não identificado'. Preserve a moeda e o formato vistos. Para cada prato, sugira uma descrição breve somente se o cardápio trouxer uma; gere também um prompt para criar uma foto realista do prato, sem palavras ou letras na imagem. Retorne todos os itens legíveis." }
        ]
      }],
      text: { format: { type: "json_schema", name: "restaurant_menu", strict: true, schema: menuSchema } }
    });

    const menu = JSON.parse(response.output_text);
    if (!Array.isArray(menu.items)) throw new Error("A resposta da IA não contém a lista de pratos.");
    if (menu.items.length > 30) menu.items = menu.items.slice(0, 30);
    res.json({ menu });
  } catch (error) {
    const failure = apiFailure("Falha na leitura do cardápio", error, "Não foi possível ler o cardápio. Confira o modelo e tente uma imagem mais nítida.");
    res.status(failure.status).json({ error: failure.message });
  }
});

app.post("/api/generate-image", async (req, res) => {
  const client = getClient();
  if (!client) return res.status(503).json({ error: "Configure a chave OPENAI_API_KEY no arquivo .env." });
  const name = String(req.body?.name || "").slice(0, 120).trim();
  const itemPrompt = String(req.body?.prompt || "").slice(0, 1200).trim();
  if (!name || !itemPrompt) return res.status(400).json({ error: "Nome e descrição do prato são necessários." });

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-6-astra",
      input: `Crie uma fotografia gastronômica realista de ${name}. ${itemPrompt}. Apresente o prato em louça bonita, luz natural suave, composição editorial de restaurante. Sem texto, letras, logotipos ou marcas d'água.`,
      tools: [{ type: "image_generation" }]
    });
    const imageCall = response.output.find((item) => item.type === "image_generation_call" && item.result);
    if (!imageCall) throw new Error("A API não retornou uma imagem.");
    await mkdir(generatedDir, { recursive: true });
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(generatedDir, filename), Buffer.from(imageCall.result, "base64"));
    res.json({ url: `/generated/${filename}` });
  } catch (error) {
    const failure = apiFailure("Falha na geração da imagem", error, "Não foi possível gerar a imagem deste prato.");
    res.status(failure.status).json({ error: failure.message });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "O arquivo deve ter até 10 MB." });
  }
  res.status(400).json({ error: error.message || "Requisição inválida." });
});

app.listen(port, () => console.log(`Prato disponível em http://localhost:${port}`));
