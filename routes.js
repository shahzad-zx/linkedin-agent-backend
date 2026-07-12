import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import dotenv from "dotenv";

import { findUserByEmail, findUserById, createUser } from "./db.js";
import { requireAuth } from "./middleware/auth.js";

dotenv.config();

const router = express.Router();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const MODEL = "llama-3.3-70b-versatile";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: false, // set true once you deploy behind HTTPS
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

// Shared helper: calls Groq with a system prompt + message history, returns parsed JSON.
async function callGroq(systemPrompt, history) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt }, ...history],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Groq API error:", response.status, errText);
    throw new Error(`Groq API returned ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

// ---------- PROMPTS ----------

const POST_SYSTEM_PROMPT = `You write LinkedIn posts for the user based on the topic and angle they provide.

Rules for every post:
- Hook-driven opening line (no "I'm excited to announce")
- Short paragraphs, max 2 sentences each, generous whitespace
- Use **word** for bold emphasis on key phrases (2-4 per post, not more)
- End with one clear call to action
- 3-5 relevant hashtags, placed on their own line at the end
- No corporate jargon ("synergy", "paradigm shift", "leverage")
- Sound like a real person, not a marketing bot

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"post": "full post text with \\n for line breaks", "hashtags": ["#Tag1","#Tag2"]}`;

const FLOWCHART_SYSTEM_PROMPT = `You convert a short description into a clear Mermaid.js flowchart.

Rules:
- Use "flowchart TD" (top-down) unless the process is clearly a sequence between actors, then use "sequenceDiagram"
- Keep node labels short (2-6 words)
- 4 to 10 nodes is the sweet spot — don't over-complicate
- Use simple node IDs (A, B, C...) and --> arrows
- Do not include styling/class directives, just structure

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"title": "short title for the diagram", "mermaid": "flowchart TD\\nA[Start] --> B[Next step]\\n..."}`;

const TABLE_SYSTEM_PROMPT = `You convert a short description into structured data for a clean reference/comparison table, the kind that performs well as a LinkedIn carousel or infographic image.

Rules:
- 2 to 5 columns, 3 to 8 rows — keep it scannable, not a data dump
- Column headers short (1-3 words)
- Cell content short (a phrase, not a paragraph)
- Pick the most useful columns for the topic (e.g. comparison: Option / Pros / Cons; process: Step / What happens / Why it matters)

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"title": "short title for the table", "columns": ["Col1","Col2"], "rows": [["cell","cell"], ["cell","cell"]]}`;

const CHEATSHEET_SYSTEM_PROMPT = `You convert a short topic into structured content for a technical cheat-sheet reference card (like a quick-reference poster developers save and reuse).

Rules:
- 3 to 5 named sections (categories that break the topic down logically)
- Each section: 2 to 5 items
- An item is either a short tip (label only) or a code example (label + a genuinely short 1-3 line code snippet)
- Be information-dense and precise, like a real cheat sheet — no fluffy explanations
- Use \\n inside "code" for multi-line snippets

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"title": "short title", "subtitle": "one-line description", "sections": [{"name": "Section name", "items": [{"label": "short label", "code": "optional code or null"}]}]}`;

const CHEATSHEET_IMAGE_SYSTEM_PROMPT = `/Visualizelearning You convert a short topic into a highly structured infographic cheatsheet.

Rules:
- You must dynamically adapt all titles, pills, flow steps, folder tree structure, files, and code snippets to match the user's requested topic/technology (e.g., React Hooks, Docker, Git, Python, SQL, CSS, etc.). Do not return MVC or Express.js unless that is what the user asked for.
- Identify the core concepts, workflow steps, folder structure tree, and code snippets for the given topic.
- Provide 2 to 4 definition pills explaining the core entities of the requested topic.
- Provide 3 to 5 sequential flow steps showing the workflow/execution order of the requested topic.
- Provide a text-based folder structure tree illustrating the layout of a typical project for the requested topic.
- Provide 2 to 4 key files with their path, a short description, and a concise 3-10 line code example showing practical usage. Use \\n inside "code" for multi-line snippets.
- Provide a single punchy key takeaway sentence.

Respond ONLY with this JSON structure, no markdown fences, no preamble:
{
  "title": "Topic Title (e.g., React Hooks Cheatsheet)",
  "subtitle": "Short description of the topic - max 2 sentences",
  "pills": [
    {"label": "Label 1", "desc": "Short description of first entity/concept", "color": "#10B981"},
    {"label": "Label 2", "desc": "Short description of second entity/concept", "color": "#3B82F6"}
  ],
  "flow": [
    {"step": "1", "name": "STEP 1 NAME", "desc": "What happens in step 1"},
    {"step": "2", "name": "STEP 2 NAME", "desc": "What happens in step 2"}
  ],
  "folder_structure": "project-root/\\n├── src/\\n│   └── index.js\\n└── package.json",
  "files": [
    {
      "name": "FILE_ROLE",
      "file": "path/to/file.js",
      "desc": "Short description of this file's purpose.",
      "code": "code snippet"
    }
  ],
  "takeaway": "Key takeaway sentence summarizing the main benefit of this topic."
}`;

const COVER_SYSTEM_PROMPT = `You write a bold, scroll-stopping headline for a LinkedIn carousel cover slide, in the style of viral tech-education posts (think: big stacked text, one punchy phrase highlighted).

Rules:
- 4 to 9 words total, split across 2-4 short lines
- Identify ONE short phrase (1-3 words) from those lines to visually highlight — pick the punchiest, most attention-grabbing part
- No hashtags, no emoji, no quotation marks

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"lines": ["line one", "line two", "line three"], "highlight": "the exact phrase from the lines above to highlight"}`;

const COMPARISON_SYSTEM_PROMPT = `You convert a short topic/description into structured data for a clean side-by-side comparison (like a versus comparison card, e.g. useState vs useReducer, or pros vs cons of different options).

Rules:
- 2 to 3 comparison items (columns/options)
- For each item, provide a "name" (the option name), an optional short "badge" (e.g. "Simple State"), and a list of 3 to 6 key "points" (features, pros, cons, or details)
- Keep descriptions brief and punchy (1 sentence or a short phrase)
- Choose a suitable main "title" and "subtitle"

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"title": "comparison title", "subtitle": "optional description", "options": [{"name": "Option Name", "badge": "Short Badge", "points": ["point 1", "point 2", "point 3"]}]}`;

const ROADMAP_SYSTEM_PROMPT = `You convert a short description into a structured step-by-step career path, skill roadmap, or project timeline (like a learning path or sequential milestones).

Rules:
- 4 to 8 milestones (steps)
- For each milestone: step number (1, 2, 3...), a short "title" (milestone name), a "goal" description (what to achieve), and a list of 2-4 key "skills" or sub-tasks
- Keep content concise, informative, and highly practical

Respond with ONLY raw JSON, no markdown fences, no preamble:
{"title": "roadmap title", "subtitle": "optional description", "steps": [{"step": 1, "title": "Milestone Title", "goal": "Goal/Objective", "skills": ["Skill A", "Skill B"]}]}`;

// ---------- ROUTES ----------

// ---------- AUTH ----------

router.post("/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: "Name, email, and password are all required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash,
  });

  const token = signToken(user.id);
  res.cookie("token", token, COOKIE_OPTS);
  res.status(201).json({ user: publicUser(user) });
});

router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password." });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password." });

  const token = signToken(user.id);
  res.cookie("token", token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
});

router.post("/auth/logout", (req, res) => {
  res.clearCookie("token", COOKIE_OPTS);
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ user: null });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.userId);
    if (!user) return res.status(401).json({ user: null });
    res.json({ user: publicUser(user) });
  } catch {
    res.status(401).json({ user: null });
  }
});

// ---------- GENERATE POST ----------

router.post("/generate", requireAuth, async (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: "Missing or invalid 'history' array." });
  }
  try {
    const parsed = await callGroq(POST_SYSTEM_PROMPT, history);
    res.json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    res.status(502).json({ error: err.message || "Server error while contacting Groq API." });
  }
});

// ---------- GENERATE VISUALS ----------

router.post("/generate-visual/:visualType?", requireAuth, async (req, res) => {
  const { type, idea } = req.body;
  const visualType = req.params.visualType || "default"; // default or visualizelearning

  const VALID_TYPES = ["flowchart", "table", "cheatsheet", "comparison", "roadmap", "cover"];

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }
  if (!idea?.trim()) {
    return res.status(400).json({ error: "Missing 'idea' text." });
  }

  // Select prompt based on visualization type
  const promptMap = {
    flowchart: FLOWCHART_SYSTEM_PROMPT,
    table: TABLE_SYSTEM_PROMPT,
    cheatsheet: visualType === "visualizelearning"
      ? CHEATSHEET_IMAGE_SYSTEM_PROMPT
      : CHEATSHEET_SYSTEM_PROMPT,
    comparison: COMPARISON_SYSTEM_PROMPT,
    roadmap: ROADMAP_SYSTEM_PROMPT,
    cover: COVER_SYSTEM_PROMPT,
  };

  const history = [{ role: "user", content: idea }];

  try {
    const parsed = await callGroq(promptMap[type], history);
    res.json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    res.status(502).json({ error: err.message || "Server error while contacting Groq API." });
  }
});

export default router;
