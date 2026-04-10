// ============================================================
// SUPABASE SETUP INSTRUCTIONS
// ============================================================
// 1. Create a free project at https://supabase.com
// 2. Replace SUPABASE_URL and SUPABASE_ANON_KEY below with
//    your project's values from: Project Settings → API
// 3. Run the SQL schema in your Supabase SQL Editor (see bottom
//    of this file for the full schema as a comment block)
// 4. In Supabase Storage, create a bucket called: cii-exports
//    Set it to PUBLIC so download links work
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Legend,
} from "recharts";

// ── SUPABASE CONFIG ────────────────────────────────────────────────────────────
const SUPABASE_URL    = "https://csvznkznuwubynzqzxli.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzdnpua3pudXd1YnluenF6eGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0Mjk0MzAsImV4cCI6MjA5MDAwNTQzMH0.EZexnZBOBLNPq0qQRM_ZNQKQpm9xCvssKx4AYVU2-Gc";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_ANON_KEY,
  "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
};

async function sbRequest(method, path, body = null, extraHeaders = {}) {
  const url = `${SUPABASE_URL}${path}`;
  const opts = { method, headers: { ...BASE_HEADERS, ...extraHeaders } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(_) { json = text; }
  if (!res.ok) { console.error(`[Supabase ${method} ${path}] HTTP ${res.status}:`, json); return { data: null, error: json }; }
  return { data: json, error: null };
}

const sb = {
  async insert(table, payload) {
    const isArray = Array.isArray(payload);
    const { data, error } = await sbRequest("POST", `/rest/v1/${table}`, payload, { "Prefer": "return=representation" });
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    if (isArray) return data;
    return Array.isArray(data) ? data[0] : data;
  },
  async upsert(table, payload, onConflict = "id") {
    const { data, error } = await sbRequest("POST", `/rest/v1/${table}?on_conflict=${onConflict}`, payload, { "Prefer": "resolution=merge-duplicates,return=representation" });
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    return Array.isArray(data) ? data[0] : data;
  },
  async patch(table, filter, payload) {
    const { data, error } = await sbRequest("PATCH", `/rest/v1/${table}?${filter}`, payload, { "Prefer": "return=minimal" });
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    return data;
  },
  async select(table, filter = "") {
    const { data, error } = await sbRequest("GET", `/rest/v1/${table}${filter ? `?${filter}` : ""}`, null);
    if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    return data;
  },
  async uploadFile(bucket, path, blob, contentType = "image/png") {
    const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": contentType, "x-upsert": "true" },
      body: blob,
    });
    const text = await res.text();
    if (!res.ok) { console.error("[Supabase Storage upload] Error:", text); throw new Error(text); }
    return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
  },
};

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function dbUpsertUser(userInfo) {
  const payload = {
    email: userInfo.email.toLowerCase().trim(),
    full_name: userInfo.name.trim(),
    phone: userInfo.phone.trim(),
    designation: userInfo.designation,
    organization: userInfo.organization.trim(),
    updated_at: new Date().toISOString(),
  };
  const row = await sb.upsert("cii_users", payload, "email");
  return row;
}

async function dbCreateSession(userId) {
  const sessionId = genId();
  const row = await sb.insert("cii_sessions", { id: sessionId, user_id: userId, started_at: new Date().toISOString(), status: "in_progress" });
  return row;
}

async function dbSaveAnswers(sessionId, answers) {
  const rows = Object.entries(answers)
    .filter(([_, v]) => v !== undefined && v !== null && v !== "")
    .map(([question_id, answer_value]) => ({
      session_id: sessionId, question_id,
      answer_value: typeof answer_value === "object" ? JSON.stringify(answer_value) : String(answer_value),
      saved_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 10) {
    await sb.insert("cii_answers", rows.slice(i, i + 10));
  }
}

async function dbSaveResults(sessionId, userId, results, aiData, userInfo) {
  const { dims, cii } = results;
  const profile = getProfile(cii);
  const payload = {
    session_id: sessionId, user_id: userId, cii_score: cii, profile_name: profile.name, profile_tag: profile.tag,
    dim_divergent: dims[0], dim_assoc: dims[1], dim_risk: dims[2], dim_vision: dims[3], dim_behavior: dims[4], dim_innovation: dims[5],
    ai_narrative: aiData?.narrative || null, ai_key_insight: aiData?.key_insight || null, ai_strengths: aiData?.strengths || null,
    ai_blind_spots: aiData?.blind_spots || null, ai_persona_type: aiData?.persona_type || null,
    ai_improvements: aiData?.improvements ? JSON.stringify(aiData.improvements) : null,
    completed_at: new Date().toISOString(),
  };
  const row = await sb.insert("cii_results", payload);
  await sb.patch("cii_sessions", `id=eq.${sessionId}`, { status: "completed", completed_at: new Date().toISOString() });
  return row;
}

async function loadHtml2Canvas() {
  if (window.html2canvas) return window.html2canvas;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error("html2canvas failed to load"));
    document.head.appendChild(s);
  });
}

async function captureDashboard(el) {
  const h2c = await loadHtml2Canvas();
  const prevBodyOF = document.body.style.overflow;
  const prevHtmlOF = document.documentElement.style.overflow;
  document.body.style.overflow = "visible";
  document.documentElement.style.overflow = "visible";
  try {
    return await h2c(el, {
      scale: 2, useCORS: true, allowTaint: true, backgroundColor: "#edeae4",
      width: el.offsetWidth, height: el.offsetHeight, windowWidth: el.offsetWidth, windowHeight: el.offsetHeight, logging: false,
      onclone: (clonedDoc) => {
        clonedDoc.querySelectorAll("*").forEach(node => { node.style.animation = "none"; node.style.transition = "none"; });
        clonedDoc.querySelectorAll(".fi,.fu").forEach(node => { node.style.opacity = "1"; node.style.transform = "none"; });
        clonedDoc.body.style.overflow = "visible";
        clonedDoc.documentElement.style.overflow = "visible";
      },
    });
  } finally {
    document.body.style.overflow = prevBodyOF;
    document.documentElement.style.overflow = prevHtmlOF;
  }
}

async function dbSaveDashboardExport(sessionId, userId, canvas) {
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("toBlob returned null")), "image/png")
  );
  const filename = `dashboard_${userId}_${sessionId}.png`;
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/cii-exports/${filename}`, {
    method: "POST",
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "image/png", "x-upsert": "true" },
    body: blob,
  });
  if (!uploadRes.ok) { const errText = await uploadRes.text(); throw new Error(`Storage upload failed (${uploadRes.status}): ${errText}`); }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/cii-exports/${filename}`;
  try { await sb.insert("cii_dashboard_exports", { session_id: sessionId, user_id: userId, file_url: publicUrl, exported_at: new Date().toISOString() }); } catch(e) { console.warn("[Dashboard] Export record insert failed:", e.message); }
  return publicUrl;
}

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const C = {
  bg:"#f8f5f0", cream:"#fdfaf6", white:"#ffffff",
  ink:"#1c1814", inkM:"#5a5248", inkL:"#a09588", inkXL:"#d4cfc9",
  gold:"#b07d3a", goldL:"#d4a055", goldBg:"rgba(176,125,58,0.08)",
  s1:"#c17f3a", s2:"#7b52c2", s3:"#2a9e72", s4:"#d04545", s5:"#2887b8",
  navy:"#1e2d40",
};

const Illus = {
  umbrella: (<svg viewBox="0 0 120 80" fill="none"><ellipse cx="60" cy="32" rx="38" ry="20" fill={C.s1} opacity=".15"/><path d="M22 32 Q60 4 98 32" stroke={C.s1} strokeWidth="2.5" fill={C.s1} fillOpacity=".2"/><line x1="60" y1="32" x2="60" y2="70" stroke={C.s1} strokeWidth="2.5" strokeLinecap="round"/><path d="M60 70 Q66 76 62 78" stroke={C.s1} strokeWidth="2.5" strokeLinecap="round" fill="none"/><circle cx="32" cy="55" r="4" fill={C.s1} opacity=".3"/><circle cx="88" cy="48" r="3" fill={C.s1} opacity=".2"/></svg>),
  silence:  (<svg viewBox="0 0 120 80" fill="none"><circle cx="60" cy="40" r="28" stroke={C.s1} strokeWidth="1.5" opacity=".2" fill={C.s1} fillOpacity=".05"/><circle cx="60" cy="40" r="18" stroke={C.s1} strokeWidth="1.5" opacity=".3" fill={C.s1} fillOpacity=".07"/><circle cx="60" cy="40" r="8" fill={C.s1} opacity=".2"/></svg>),
  rat:      (<svg viewBox="0 0 120 80" fill="none"><rect x="8" y="28" width="28" height="22" rx="6" fill={C.s1} fillOpacity=".12" stroke={C.s1} strokeWidth="1.2" opacity=".4"/><rect x="46" y="28" width="28" height="22" rx="6" fill={C.s1} fillOpacity=".12" stroke={C.s1} strokeWidth="1.2" opacity=".4"/><rect x="84" y="28" width="28" height="22" rx="6" fill={C.s1} fillOpacity=".12" stroke={C.s1} strokeWidth="1.2" opacity=".4"/></svg>),
  risk:     (<svg viewBox="0 0 120 80" fill="none"><path d="M60 10 L90 65 L30 65 Z" fill={C.s2} fillOpacity=".1" stroke={C.s2} strokeWidth="1.5" opacity=".4"/><circle cx="60" cy="45" r="4" fill={C.s2} opacity=".4"/></svg>),
  vision:   (<svg viewBox="0 0 120 80" fill="none"><path d="M20 50 Q60 10 100 50" stroke={C.s3} strokeWidth="2" fill="none" opacity=".3"/><circle cx="60" cy="40" r="9" fill={C.s3} fillOpacity=".2" stroke={C.s3} strokeWidth="1.5" opacity=".5"/><circle cx="60" cy="40" r="4" fill={C.s3} opacity=".4"/></svg>),
  behavior: (<svg viewBox="0 0 120 80" fill="none"><rect x="15" y="20" width="25" height="40" rx="4" fill={C.s4} fillOpacity=".1" stroke={C.s4} strokeWidth="1.2" opacity=".35"/><rect x="47" y="30" width="25" height="30" rx="4" fill={C.s4} fillOpacity=".15" stroke={C.s4} strokeWidth="1.2" opacity=".45"/><rect x="79" y="15" width="25" height="45" rx="4" fill={C.s4} fillOpacity=".2" stroke={C.s4} strokeWidth="1.2" opacity=".55"/></svg>),
  innovation:(<svg viewBox="0 0 120 80" fill="none"><circle cx="60" cy="38" r="22" fill={C.s5} fillOpacity=".08" stroke={C.s5} strokeWidth="1.5" opacity=".3"/><path d="M60 16 L64 30 L78 30 L67 39 L71 53 L60 44 L49 53 L53 39 L42 30 L56 30Z" fill={C.s5} fillOpacity=".2" stroke={C.s5} strokeWidth="1" opacity=".4"/></svg>),
  welcome:  (<svg viewBox="0 0 200 120" fill="none"><circle cx="100" cy="60" r="50" fill={C.gold} fillOpacity=".07"/><circle cx="100" cy="60" r="35" fill={C.gold} fillOpacity=".1"/><path d="M80 50 Q75 38 85 35 Q88 28 96 32 Q100 25 104 32 Q112 28 115 35 Q125 38 120 50 Q126 56 120 63 Q118 72 110 70 Q106 76 100 74 Q94 76 90 70 Q82 72 80 63 Q74 56 80 50Z" fill={C.gold} fillOpacity=".18" stroke={C.gold} strokeWidth="1.5" opacity=".5"/><circle cx="45" cy="30" r="3" fill={C.s1} opacity=".3"/><circle cx="155" cy="45" r="2" fill={C.s2} opacity=".3"/><circle cx="40" cy="80" r="2.5" fill={C.s3} opacity=".3"/><circle cx="162" cy="85" r="3" fill={C.s4} opacity=".3"/></svg>),
};

const SecIllus = {
  1:<svg viewBox="0 0 240 100" fill="none"><rect width="240" height="100" fill={`${C.s1}08`}/><circle cx="120" cy="50" r="12" fill={C.s1} fillOpacity=".2" stroke={C.s1} strokeWidth="1.5" opacity=".5"/>{[{x:55,y:25},{x:185,y:22},{x:40,y:68},{x:200,y:72},{x:120,y:12}].map((p,i)=>(<g key={i}><circle cx={p.x} cy={p.y} r="6" fill={C.s1} fillOpacity=".15" stroke={C.s1} strokeWidth="1" opacity=".4"/><line x1="120" y1="50" x2={p.x} y2={p.y} stroke={C.s1} strokeWidth="1" strokeDasharray="4 3" opacity=".25"/></g>))}</svg>,
  2:<svg viewBox="0 0 240 100" fill="none"><rect width="240" height="100" fill={`${C.s2}08`}/>{[0,1,2,3].map(i=>(<path key={i} d={`M${20+i*10} 50 Q${60+i*10} ${30+i*5} ${100+i*10} 50 Q${140+i*10} ${70-i*5} ${180+i*10} 50`} stroke={C.s2} strokeWidth="1.2" fill="none" opacity={0.12+i*0.06}/>))}</svg>,
  3:<svg viewBox="0 0 240 100" fill="none"><rect width="240" height="100" fill={`${C.s3}08`}/><path d="M20 70 Q80 30 160 25 Q200 24 220 22" stroke={C.s3} strokeWidth="2" fill="none" opacity=".3"/><polygon points="218,18 222,22 218,26 230,22" fill={C.s3} opacity=".35"/></svg>,
  4:<svg viewBox="0 0 240 100" fill="none"><rect width="240" height="100" fill={`${C.s4}07`}/><path d="M40 75 L90 35 L140 55 L200 25" stroke={C.s4} strokeWidth="2" fill="none" opacity=".3" strokeLinecap="round"/></svg>,
  5:<svg viewBox="0 0 240 100" fill="none"><rect width="240" height="100" fill={`${C.s5}07`}/><path d="M120 15 L125 32 L142 32 L129 42 L134 59 L120 49 L106 59 L111 42 L98 32 L115 32Z" fill={C.s5} fillOpacity=".15" stroke={C.s5} strokeWidth="1.2" opacity=".4"/></svg>,
};

const Qs = [
  {id:"q1", s:1,type:"open",  illus:Illus.umbrella, text:"List every possible use for a broken umbrella.", hint:"Physical · metaphorical · artistic · absurd · scientific — push far past the obvious.", ph:"One idea per line..."},
  {id:"q2", s:1,type:"open",  illus:Illus.silence,  text:"In how many ways could complete SILENCE be a valuable tool or resource?", hint:"Therapy · technology · business · art · military · nature · education...", ph:"One idea per line..."},
  {id:"q3", s:1,type:"rat",   illus:Illus.rat, text:"Find ONE word that connects all three:", words:["PINE","CRAB","SAUCE"],    options:["APPLE","TREE","FRUIT","JUICE"],  answer:"APPLE"},
  {id:"q4", s:1,type:"rat",   illus:Illus.rat, text:"Find ONE word that connects all three:", words:["FALLING","ACTOR","DUST"], options:["FILM","SKY","STAR","STAGE"],    answer:"STAR"},
  {id:"q5", s:1,type:"rat",   illus:Illus.rat, text:"Find ONE word that connects all three:", words:["LIGHT","BIRTHDAY","STICK"],options:["WAX","PARTY","FIRE","CANDLE"], answer:"CANDLE"},
  {id:"q6", s:2,type:"likert",illus:Illus.risk,   text:"I feel energized — not anxious — when starting a project with no clear direction."},
  {id:"q7", s:2,type:"likert",illus:Illus.risk,   text:"Failure feels like useful data to me, not a personal setback."},
  {id:"q8", s:2,type:"likert",illus:Illus.risk,   text:"I regularly explore topics completely unrelated to my work, purely out of curiosity."},
  {id:"q9", s:2,type:"likert",illus:Illus.risk,   text:"I actively seek out people who think very differently from me."},
  {id:"q10",s:2,type:"likert",illus:Illus.risk,   reversed:true, text:"I find it unsettling when a situation has no clear right answer or obvious path forward."},
  {id:"q11",s:3,type:"likert",illus:Illus.vision, text:"I can vividly imagine products, systems, or worlds that don't yet exist."},
  {id:"q12",s:3,type:"likert",illus:Illus.vision, text:"I continue working on ideas even when no one around me believes in them yet."},
  {id:"q13",s:3,type:"likert",illus:Illus.vision, text:"I feel compelled to build or create things even without any external reward."},
  {id:"q14",s:3,type:"likert",illus:Illus.vision, text:"I often stop mid-task to question whether I'm solving the RIGHT problem."},
  {id:"q15",s:3,type:"likert",illus:Illus.vision, reversed:true, text:"I tend to lose momentum on creative ideas once the initial excitement fades."},
  {id:"q16",s:4,type:"mcq", illus:Illus.behavior, text:"When you encounter a frustrating, broken process, you typically:", options:["Accept it and adapt around it","Work around it quietly on your own","Propose a better way to whoever's responsible","Redesign or fix it yourself without waiting"], scores:[1,2,3,4]},
  {id:"q17",s:4,type:"mcq", illus:Illus.behavior, text:"How often do you connect ideas from completely unrelated fields to solve your problems?", options:["Almost never","Occasionally when stuck","Regularly — one of my first approaches","It's my default way of thinking"], scores:[1,2,3,4]},
  {id:"q18",s:4,type:"mcq", illus:Illus.behavior, text:"In the last year, have you created something — a product, system, or solution — that didn't exist before?", options:["Not really","Started something but didn't finish","Yes, once or twice","Yes, multiple times"], scores:[1,2,3,4]},
  {id:"q19",s:4,type:"mcq", illus:Illus.behavior, text:"Your relationship with constraints — deadlines, budgets, rules:", options:["They frustrate and block my thinking","I just work with what I have","They often make me think more creatively","I actively create constraints to spark better ideas"], scores:[1,2,3,4]},
  {id:"q20",s:4,type:"mcq", illus:Illus.behavior, text:"When someone dismisses your creative idea, you typically:", options:["Let it go — they may be right","Feel frustrated but move on","Seek their reasoning to understand why","Find another way to demonstrate its merit"], scores:[1,2,3,4]},
  {id:"q21",s:5,type:"scenario",scene:"🏢",sceneLabel:"STARTUP CRISIS",  illus:Illus.innovation, text:"Your startup's main product just became obsolete overnight.", options:["Deeply analyze what makes the competitor's product superior","Immediately negotiate a partnership or acquisition with them","Find a different problem your existing technology could now solve","Pivot to a new market entirely using your team's core skills"], scores:[2,2,4,3]},
  {id:"q22",s:5,type:"scenario",scene:"🌉",sceneLabel:"URBAN PROBLEM",   illus:Illus.innovation, text:"A public bridge keeps getting vandalized despite all traditional interventions.", options:["Better surveillance cameras and increased fines","Apply permanent anti-graffiti coating everywhere","Commission local artists to transform it into a mural destination","Demolish and redesign the bridge entirely"], scores:[1,2,4,1]},
  {id:"q23",s:5,type:"scenario",scene:"🏫",sceneLabel:"EDUCATION",       illus:Illus.innovation, text:"You must teach creativity to 10-year-olds. Your most effective approach:", options:["Teach classic techniques: brainstorming, mind maps, SCAMPER","Show curated examples of great creative work throughout history","Give them impossible problems with no right answers — then step back","Master techniques, then explicitly teach them to break every rule"], scores:[2,2,3,4]},
  {id:"q24",s:5,type:"scenario",scene:"🏙️",sceneLabel:"CITY CHALLENGE", illus:Illus.innovation, text:"Your city is losing talented young people to other cities. Most innovative retention strategy:", options:["Lower taxes, increase salaries, improve standard amenities","Build better transport, housing, and green spaces","Create a city-wide experimental zone where regulations are suspended","Launch a civic co-ownership model where residents hold real equity"], scores:[1,2,3,4]},
  {id:"q25",s:5,type:"scenario",scene:"🧠",sceneLabel:"TECH & HUMANITY", illus:Illus.innovation, text:"You've built tech that lets people fully experience another person's memories. You launch it first as:", options:["A clinical therapy tool for trauma healing","A courtroom evidence platform","A revolutionary entertainment and art medium beyond VR","An education platform where students literally live history"], scores:[3,2,4,4]},
];

const SECS = [
  {id:1,title:"COGNITIVE CREATIVITY", sub:"Divergent Thinking & Remote Association", color:C.s1,short:"Cognitive"},
  {id:2,title:"INNER LANDSCAPE",       sub:"Risk Tolerance & Openness to Experience", color:C.s2,short:"Mindset"},
  {id:3,title:"VISION & DRIVE",        sub:"Creative Motivation & Metacognition",     color:C.s3,short:"Vision"},
  {id:4,title:"CREATIVE BEHAVIOR",     sub:"Real-World Actions & Creative Habits",    color:C.s4,short:"Behavior"},
  {id:5,title:"INNOVATION THINKING",   sub:"Scenario & Consequence Reasoning",        color:C.s5,short:"Innovation"},
];

const PROFILES = [
  {min:85,name:"Visionary Innovator",  tag:"Top 5%",       color:C.s1,range:"85–100",desc:"Exceptional ideational fluency, rare associative depth, and the drive to act on bold visions."},
  {min:70,name:"Creative Catalyst",    tag:"Top 20%",      color:C.s3,range:"70–84", desc:"Strong divergent thinking with real motivation to act on unconventional ideas."},
  {min:55,name:"Adaptive Innovator",   tag:"Above Average",color:C.s2,range:"55–69", desc:"Meaningful creative capacity with clear room to grow through deliberate practice."},
  {min:40,name:"Structured Thinker",   tag:"Average",      color:C.s5,range:"40–54", desc:"Strong analytical skills within frameworks — creative potential underutilized."},
  {min:0, name:"Conventional Executor",tag:"Developing",   color:C.inkL,range:"0–39",desc:"Excels at reliable implementation — creative capacity grows with targeted exercises."},
];

const DIM = {
  names:  ["Divergent Thinking","Remote Association","Risk & Openness","Vision & Drive","Creative Behavior","Innovation Thinking"],
  short:  ["Divergent Thinking","Remote Assoc.","Risk & Openness","Vision & Drive","Cr. Behavior","Innovation"],
  abbr:   ["Div","RemA","Risk","Vis","Beh","Inn"],
  colors: [C.s1,"#e07a3a",C.s2,C.s3,C.s4,C.s5],
  weights:[0.20,0.10,0.20,0.20,0.15,0.15],
  descs:  ["Originality & volume of ideas","Linking distant concepts","Tolerance for ambiguity & risk","Vision strength & intrinsic drive","Creative habits in real life","Bold thinking on hard problems"],
};

const AVG = [45, 55, 50, 48, 42, 52];
const getProfile = cii => PROFILES.find(p=>cii>=p.min)||PROFILES[PROFILES.length-1];

// ── INDIAN PHONE VALIDATION ────────────────────────────────────────────────────
// Valid Indian mobile: starts with 6, 7, 8, or 9; exactly 10 digits (after stripping +91 or 0)
function parseIndianPhone(raw) {
  const stripped = raw.replace(/[\s\-().]/g, "");
  // Remove country code prefix if present
  const normalized = stripped.replace(/^(\+91|91|0)/, "");
  return normalized;
}

function isValidIndianPhone(raw) {
  const num = parseIndianPhone(raw);
  return /^[6-9]\d{9}$/.test(num);
}

async function scoreWithAI(openAnswers, dims, allAnswers) {
  const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 40)));
  const openLabeled = ["Q1 (Uses for a broken umbrella)", "Q2 (Silence as a valuable resource)"].map((label, i) => `${label}:\n${openAnswers[i]?.trim() || "(no answer)"}`).join("\n\n");
  const behaviorSummary = Qs.filter(q => q.s === 4).map(q => { const idx = allAnswers?.[q.id]; const chosen = idx != null ? q.options[idx] : "(not answered)"; return `• ${q.text.slice(0,70)}  -> "${chosen}"`; }).join("\n");
  const scenarioSummary = Qs.filter(q => q.s === 5).map(q => { const idx = allAnswers?.[q.id]; const chosen = idx != null ? q.options[idx] : "(not answered)"; return `• ${q.sceneLabel}: "${chosen}"`; }).join("\n");
  const likertSummary = Qs.filter(q => q.s === 2 || q.s === 3).map(q => { const v = allAnswers?.[q.id] ?? "?"; return `• [${v}/5] ${q.text.slice(0,80)}`; }).join("\n");
  const sortedDims = dims.map((d,i)=>({i,d,name:DIM.short[i]})).sort((a,b)=>a.d-b.d);
  const bottom2 = sortedDims.slice(0,2);
  const top1    = sortedDims[sortedDims.length-1];
  const dimContext = DIM.short.map((n,i)=>`${n}: ${dims[i]}/100`).join(" | ");

  const prompt = `You are a senior psychometric researcher and creativity coach. Analyse this person's full Creative Innovation Index assessment.

=== DIMENSION SCORES ===
${dimContext}
Strongest: ${top1.name} (${top1.d}/100) | Weakest: ${bottom2[0].name} (${bottom2[0].d}/100), ${bottom2[1].name} (${bottom2[1].d}/100)

=== OPEN-ENDED DIVERGENT THINKING RESPONSES ===
${openLabeled}

=== BEHAVIORAL CHOICES ===
${behaviorSummary}

=== SCENARIO RESPONSES ===
${scenarioSummary}

=== MINDSET & VISION SELF-RATINGS ===
${likertSummary}

=== DIVERGENT SCORING GUIDE ===
- 85-100: 15+ ideas, wildly varied domains, metaphorical, absurd, AND practical
- 65-84:  8-15 ideas, clear variety, some unexpected
- 45-64:  5-10 ideas, mostly predictable
- 25-44:  Fewer than 5 ideas, mostly obvious
- 0-24:   1-3 ideas, all conventional

Return ONLY a raw JSON object. No markdown fences. No preamble. No trailing text.
{
  "div_q1": <integer 0-100>,
  "div_q2": <integer 0-100>,
  "narrative": "<3-4 sentences. Reference specific ideas they wrote. Connect open answers to behavioral patterns. Be precise and personal, not generic.>",
  "key_insight": "<One sharp sentence: the single most distinctive thing about how THIS person's mind works.>",
  "strengths": "<One concrete sentence naming their strongest creative trait, grounded in their scores AND responses.>",
  "blind_spots": "<One honest, specific sentence about their most underdeveloped creative area.>",
  "improvements": [
    {"dim": ${bottom2[0].i}, "action": "<Specific named 15-day daily exercise for ${bottom2[0].name}. E.g. 'Every morning for 15 days, pick a random object and list 20 unrelated uses in 5 minutes'>"},
    {"dim": ${bottom2[1].i}, "action": "<Specific named 15-day daily exercise for ${bottom2[1].name}.>"},
    {"dim": ${top1.i},       "action": "<A stretch challenge to push their strongest area (${top1.name}) even further.>"}
  ],
  "persona_type": "<2-3 word archetype specific to this profile — e.g. 'Systematic Dreamer', 'Bold Connector', 'Cautious Visionary'>"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1600, messages: [{ role: "user", content: prompt }] }),
  });

  if (!res.ok) { const errText = await res.text(); throw new Error(`API ${res.status}: ${errText}`); }
  const data = await res.json();
  const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("").trim();
  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch(e) { const match = cleaned.match(/\{[\s\S]*\}/); if (match) { parsed = JSON.parse(match[0]); } else { throw new Error("AI response not valid JSON: " + cleaned.slice(0, 300)); } }
  return { ...parsed, _divScores: [clamp(parsed.div_q1 ?? 40), clamp(parsed.div_q2 ?? 40)] };
}

function computeScore(answers, aiScores) {
  const openQs=Qs.filter(q=>q.type==="open");
  const div=aiScores ? aiScores.slice(0,2).reduce((s,v)=>s+v,0)/2 : openQs.reduce((s,q)=>{const n=(answers[q.id]||"").split("\n").filter(l=>l.trim().length>2).length;return s+Math.min(n/7*100,100);},0)/openQs.length;
  const ratQs=Qs.filter(q=>q.type==="rat");
  const assoc=ratQs.filter(q=>answers[q.id]===q.answer).length/ratQs.length*100;
  const s2Qs=Qs.filter(q=>q.s===2);
  const s2=s2Qs.reduce((s,q)=>{const v=answers[q.id]??3;return s+(q.reversed?(6-v):v);},0);
  const pers1=(s2-s2Qs.length)/(s2Qs.length*4)*100;
  const s3Qs=Qs.filter(q=>q.s===3);
  const s3=s3Qs.reduce((s,q)=>{const v=answers[q.id]??3;return s+(q.reversed?(6-v):v);},0);
  const pers2=(s3-s3Qs.length)/(s3Qs.length*4)*100;
  const beh=Qs.filter(q=>q.s===4).reduce((s,q)=>{const i=answers[q.id];return s+(i!=null?q.scores[i]:1);},0);
  const behS=(beh-5)/15*100;
  const inn=Qs.filter(q=>q.s===5).reduce((s,q)=>{const i=answers[q.id];return s+(i!=null?q.scores[i]:1);},0);
  const innS=(inn-5)/15*100;
  const dims=[div,assoc,pers1,pers2,behS,innS].map(d=>Math.round(Math.max(0,Math.min(100,d))));
  const cii=Math.round(dims.reduce((s,d,i)=>s+d*DIM.weights[i],0));
  return {dims,cii};
}

// ── GLOBAL CSS — uses viewport-relative units for universal laptop scaling ─────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:clamp(13px,1.1vw,16px)}
body,html{
  font-family:'DM Sans',sans-serif;
  background:${C.bg};
  color:${C.ink};
  overflow:hidden;
  width:100vw;
  height:100vh;
}
#__next,[data-reactroot]{height:100vh;overflow:hidden;}
@keyframes fadeUp{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes spinR{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.fu{animation:fadeUp .5s cubic-bezier(.22,1,.36,1) both}
.fi{animation:fadeIn .5s ease both}
textarea:focus,input:focus{outline:none}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-thumb{background:${C.inkXL};border-radius:2px}
.no-scroll::-webkit-scrollbar{display:none}
button,textarea,input,select{font-family:'DM Sans',sans-serif!important}
textarea::placeholder,input::placeholder{color:${C.inkXL};font-size:0.85em}
input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}

/* ── Consent checkbox ── */
.consent-check-wrap{
  display:flex;align-items:flex-start;gap:10px;
  background:${C.goldBg};border:1.5px solid ${C.gold}35;
  border-radius:10px;padding:12px 14px;cursor:pointer;
  transition:border-color .2s,background .2s;
}
.consent-check-wrap:hover{border-color:${C.gold}70;background:${C.goldBg};}
.consent-check-wrap.checked{border-color:${C.gold};background:rgba(176,125,58,0.12);}
.consent-box{
  flex-shrink:0;width:20px;height:20px;border-radius:5px;
  border:2px solid ${C.gold}60;background:${C.white};
  display:flex;align-items:center;justify-content:center;
  margin-top:1px;transition:all .2s;
}
.consent-box.checked{background:${C.gold};border-color:${C.gold};}
.phone-flag{
  position:absolute;left:12px;top:50%;transform:translateY(-50%);
  font-size:16px;line-height:1;pointer-events:none;
}
.phone-prefix{
  position:absolute;left:36px;top:50%;transform:translateY(-50%);
  font-size:13px;color:${C.inkM};font-weight:600;pointer-events:none;
  border-right:1.5px solid ${C.inkXL};padding-right:8px;line-height:1;
}
`;

// ── DESIGNATIONS ───────────────────────────────────────────────────────────────
const DESIGNATIONS = [
  "Student","Intern","Individual Contributor","Team Lead","Manager",
  "Senior Manager","Director","VP / Head of Function","C-Suite / Founder","Freelancer / Consultant","Other"
];

// ── USER DETAILS FORM ──────────────────────────────────────────────────────────
function UserDetailsForm({ onSubmit }) {
  const [form, setForm] = useState({ name:"", email:"", phone:"", designation:"", organization:"" });
  const [errors, setErrors] = useState({});
  const [focused, setFocused] = useState(null);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);

  const set = (k,v) => { setForm(p=>({...p,[k]:v})); setErrors(p=>({...p,[k]:""})); };

  const validateStep0 = () => {
    const e = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Valid email required";
    // Indian phone validation
    if (!isValidIndianPhone(form.phone)) e.phone = "Enter a valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9)";
    return e;
  };

  const validateStep1 = () => {
    const e = {};
    if (!form.designation) e.designation = "Please select a designation";
    if (!form.organization.trim()) e.organization = "Organization is required";
    if (!consentGiven) e.consent = "Please provide consent to proceed";
    return e;
  };

  const handleNext = () => {
    const e = validateStep0();
    if (Object.keys(e).length) { setErrors(e); return; }
    setStep(1);
  };

  const handleSubmit = async () => {
    const e = validateStep1();
    if (Object.keys(e).length) { setErrors(e); return; }
    setSaving(true);
    try {
      const userRow = await dbUpsertUser(form);
      const uid = userRow?.id;
      if (!uid) throw new Error("User row returned no id");
      onSubmit(form, uid);
    } catch(err) {
      console.error("[UserDetailsForm] Save failed:", err.message);
      onSubmit(form, genId());
    }
    setSaving(false);
  };

  const inputStyle = (k) => ({
    width:"100%", background:C.white,
    border:`1.5px solid ${errors[k] ? C.s4 : focused===k ? C.gold : C.inkXL}`,
    borderRadius:10, padding:"12px 14px", color:C.ink, fontSize:"0.9rem",
    lineHeight:1.5, transition:"border-color .2s",
    boxShadow: focused===k ? `0 0 0 3px ${C.gold}18` : "none",
  });

  const labelStyle = { fontSize:"0.65rem", fontWeight:700, letterSpacing:"0.18em", color:C.inkL, marginBottom:6, display:"block" };

  const progressDots = [0,1].map(i => (
    <div key={i} style={{ width: i===step ? 24 : 8, height:8, borderRadius:4, background: i<=step ? C.gold : C.inkXL, transition:"all .3s ease" }}/>
  ));

  // Display raw phone digits only, strip non-numeric for storage
  const handlePhoneChange = (e) => {
    // Allow digits, spaces, hyphens, plus sign
    const raw = e.target.value.replace(/[^\d\s\-+()]/g, "");
    set("phone", raw);
  };

  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:`linear-gradient(150deg,#fdf9f3 0%,#f5f0e8 55%,#ede6da 100%)`,
      display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", padding:"2vh 20px", overflow:"auto"
    }}>
      <div style={{maxWidth:"min(480px, 92vw)", width:"100%"}} className="fu">
        {/* Header */}
        <div style={{textAlign:"center", marginBottom:"2vh"}}>
          <div style={{
            width:"3rem", height:"3rem", borderRadius:"50%",
            background:`linear-gradient(135deg,${C.gold}25,${C.gold}10)`,
            border:`1.5px solid ${C.gold}40`,
            display:"flex", alignItems:"center", justifyContent:"center",
            margin:"0 auto 1rem", fontSize:"1.2rem"
          }}>✦</div>
          <div style={{fontSize:"0.6rem", letterSpacing:"0.42em", color:C.gold, fontWeight:700, marginBottom:"0.4rem"}}>
            BEFORE WE BEGIN
          </div>
          <h2 style={{
            fontFamily:"'Playfair Display',serif",
            fontSize:"clamp(1.4rem,3vw,2rem)", fontWeight:800,
            color:C.ink, lineHeight:1.1, marginBottom:"0.5rem"
          }}>
            {step === 0 ? "Tell us about yourself" : "Your professional context"}
          </h2>
          <p style={{fontSize:"0.8rem", color:C.inkM, lineHeight:1.7, maxWidth:360, margin:"0 auto"}}>
            {step === 0 ? "This helps personalise your Creative Innovation Index report." : "Your role context helps calibrate your results against relevant peers."}
          </p>
        </div>

        {/* Progress dots */}
        <div style={{display:"flex", justifyContent:"center", gap:6, marginBottom:"1.5vh"}}>
          {progressDots}
        </div>

        {/* Card */}
        <div style={{
          background:C.white, border:`1.5px solid ${C.inkXL}`,
          borderRadius:18, padding:"clamp(18px,3vh,28px) clamp(18px,3vw,28px)",
          boxShadow:"0 8px 40px rgba(28,24,20,0.08)"
        }}>
          {/* ── Step 0: Personal info ── */}
          {step === 0 && (
            <div style={{display:"flex", flexDirection:"column", gap:"1.1rem"}}>
              <div>
                <label style={labelStyle}>FULL NAME</label>
                <input value={form.name} onChange={e=>set("name",e.target.value)}
                  onFocus={()=>setFocused("name")} onBlur={()=>setFocused(null)}
                  placeholder="e.g. Arjun Sharma" style={inputStyle("name")}/>
                {errors.name && <div style={{fontSize:"0.65rem", color:C.s4, marginTop:4}}>{errors.name}</div>}
              </div>
              <div>
                <label style={labelStyle}>EMAIL ADDRESS</label>
                <input type="email" value={form.email} onChange={e=>set("email",e.target.value)}
                  onFocus={()=>setFocused("email")} onBlur={()=>setFocused(null)}
                  placeholder="e.g. arjun@company.com" style={inputStyle("email")}/>
                {errors.email && <div style={{fontSize:"0.65rem", color:C.s4, marginTop:4}}>{errors.email}</div>}
              </div>
              <div>
                <label style={labelStyle}>INDIAN MOBILE NUMBER</label>
                <div style={{position:"relative"}}>
                  <span className="phone-flag">🇮🇳</span>
                  <span className="phone-prefix">+91</span>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={handlePhoneChange}
                    onFocus={()=>setFocused("phone")} onBlur={()=>setFocused(null)}
                    placeholder="98765 43210"
                    maxLength={15}
                    style={{...inputStyle("phone"), paddingLeft:"70px"}}
                  />
                </div>
                {errors.phone
                  ? <div style={{fontSize:"0.65rem", color:C.s4, marginTop:4}}>{errors.phone}</div>
                  : <div style={{fontSize:"0.62rem", color:C.inkL, marginTop:4}}>10-digit Indian mobile (starts with 6–9). E.g. 98765 43210</div>
                }
              </div>
              <button onClick={handleNext} style={{
                width:"100%", background:C.ink, color:C.cream,
                border:"none", borderRadius:11, padding:"0.85rem",
                fontSize:"0.82rem", fontWeight:700, cursor:"pointer",
                letterSpacing:"0.08em", boxShadow:"0 4px 18px rgba(28,24,20,0.18)", marginTop:4
              }}>
                CONTINUE →
              </button>
            </div>
          )}

          {/* ── Step 1: Professional context + consent ── */}
          {step === 1 && (
            <div style={{display:"flex", flexDirection:"column", gap:"1.1rem"}}>
              <div>
                <label style={labelStyle}>WORK DESIGNATION</label>
                <div style={{position:"relative"}}>
                  <select value={form.designation} onChange={e=>set("designation",e.target.value)}
                    onFocus={()=>setFocused("designation")} onBlur={()=>setFocused(null)}
                    style={{...inputStyle("designation"), appearance:"none", cursor:"pointer",
                      color: form.designation ? C.ink : C.inkXL, paddingRight:36}}>
                    <option value="" disabled>Select your level</option>
                    {DESIGNATIONS.map(d=>(<option key={d} value={d}>{d}</option>))}
                  </select>
                  <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",
                    pointerEvents:"none",color:C.gold,fontSize:12}}>▾</div>
                </div>
                {errors.designation && <div style={{fontSize:"0.65rem", color:C.s4, marginTop:4}}>{errors.designation}</div>}
              </div>
              <div>
                <label style={labelStyle}>ORGANIZATION / COMPANY</label>
                <input value={form.organization} onChange={e=>set("organization",e.target.value)}
                  onFocus={()=>setFocused("organization")} onBlur={()=>setFocused(null)}
                  placeholder="e.g. Infosys, Razorpay, Self-employed..." style={inputStyle("organization")}/>
                {errors.organization && <div style={{fontSize:"0.65rem", color:C.s4, marginTop:4}}>{errors.organization}</div>}
              </div>

              {/* ── CONSENT CHECKBOX ── */}
              <div>
                <label style={labelStyle}>DATA CONSENT</label>
                <div
                  className={`consent-check-wrap ${consentGiven ? "checked" : ""}`}
                  onClick={() => { setConsentGiven(v => !v); setErrors(p=>({...p, consent:""})); }}
                  role="checkbox"
                  aria-checked={consentGiven}
                  tabIndex={0}
                  onKeyDown={e => e.key===" " && (setConsentGiven(v=>!v), setErrors(p=>({...p,consent:""})))}
                >
                  <div className={`consent-box ${consentGiven ? "checked" : ""}`}>
                    {consentGiven && (
                      <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
                        <path d="M1.5 4.5L4.5 7.5L10.5 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <p style={{fontSize:"0.75rem", color:C.inkM, lineHeight:1.7, margin:0}}>
                    I consent to providing my details for this assessment.
                    {" "}<span style={{color:C.gold, fontWeight:600}}>Details will not be shared with third parties for marketing purposes.</span>
                  </p>
                </div>
                {errors.consent && (
                  <div style={{fontSize:"0.65rem", color:C.s4, marginTop:5, display:"flex", alignItems:"center", gap:5}}>
                    <span>⚠</span> {errors.consent}
                  </div>
                )}
              </div>

              <div style={{display:"flex", gap:10, marginTop:4}}>
                <button onClick={()=>setStep(0)} style={{
                  flex:"0 0 auto", background:"transparent",
                  border:`1.5px solid ${C.inkXL}`, borderRadius:11,
                  padding:"0.85rem 1.2rem", color:C.inkM,
                  fontSize:"0.82rem", fontWeight:600, cursor:"pointer"
                }}>← Back</button>
                <button onClick={handleSubmit} disabled={saving} style={{
                  flex:1, background:saving?C.inkXL:consentGiven?C.gold:`${C.gold}60`,
                  color:C.white, border:"none", borderRadius:11, padding:"0.85rem",
                  fontSize:"0.82rem", fontWeight:700, cursor:saving?"default":consentGiven?"pointer":"not-allowed",
                  letterSpacing:"0.08em", boxShadow:consentGiven?`0 4px 18px ${C.gold}45`:"none",
                  transition:"all .2s"
                }}>
                  {saving ? "SAVING..." : "START ASSESSMENT →"}
                </button>
              </div>
            </div>
          )}
        </div>

        <p style={{textAlign:"center", fontSize:"0.62rem", color:C.inkXL, marginTop:12, letterSpacing:"0.1em"}}>
          STEP {step+1} OF 2 · {step===0 ? "PERSONAL INFO" : "PROFESSIONAL CONTEXT"}
        </p>
      </div>
    </div>
  );
}

// ── WELCOME ────────────────────────────────────────────────────────────────────
function Welcome({onStart}) {
  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:`linear-gradient(150deg,#fdf9f3 0%,#f5f0e8 55%,#ede6da 100%)`,
      display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", padding:"2vh 20px", overflow:"auto"
    }}>
      <div style={{maxWidth:"min(500px, 92vw)", width:"100%"}} className="fu">
        <div style={{width:"min(200px,40vw)", height:"auto", aspectRatio:"200/120", margin:"0 auto 2vh"}}>{Illus.welcome}</div>
        <div style={{textAlign:"center",marginBottom:"0.6rem"}}>
          <span style={{fontSize:"0.6rem",letterSpacing:"0.42em",color:C.gold,fontWeight:700}}>PSYCHOMETRIC ASSESSMENT</span>
        </div>
        <h1 style={{
          fontFamily:"'Playfair Display',serif",
          fontSize:"clamp(2.5rem,6vw,4.2rem)",
          fontWeight:800,color:C.ink,lineHeight:.92,letterSpacing:"-0.02em",
          textAlign:"center",marginBottom:"1rem"
        }}>Creative<br/>Innovation<br/><span style={{color:C.gold,fontStyle:"italic"}}>Index</span></h1>
        <p style={{fontSize:"0.82rem",color:C.inkM,lineHeight:1.8,textAlign:"center",maxWidth:400,margin:"0 auto 1.4rem"}}>
          A multi-method assessment measuring how creative and innovative you truly are — with AI-powered analysis of your actual thinking.
        </p>
        <div style={{display:"flex",gap:8,marginBottom:"1.2rem"}}>
          {[["25","Questions"],["5","Dimensions"],["~12","Minutes"]].map(([n,l])=>(
            <div key={l} style={{background:C.white,border:`1.5px solid ${C.inkXL}`,borderRadius:14,padding:"0.9rem 1rem",textAlign:"center",flex:1}}>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(1.4rem,3vw,1.8rem)",fontWeight:800,color:C.gold,lineHeight:1}}>{n}</div>
              <div style={{fontSize:"0.6rem",color:C.inkL,letterSpacing:"0.18em",marginTop:4,fontWeight:600}}>{l}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:"1.4rem"}}>
          {SECS.map(s=>(
            <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,background:C.white,borderLeft:`3px solid ${s.color}`,borderRadius:"0 10px 10px 0",padding:"0.5rem 0.9rem"}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:s.color,flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{fontSize:"0.6rem",fontWeight:700,letterSpacing:"0.2em",color:s.color}}>{s.title}</div>
                <div style={{fontSize:"0.65rem",color:C.inkL,marginTop:1}}>{s.sub}</div>
              </div>
              <div style={{fontSize:"0.6rem",color:C.inkXL}}>5 QS</div>
            </div>
          ))}
        </div>
        <button onClick={onStart} style={{
          width:"100%",background:C.ink,color:C.cream,border:"none",borderRadius:12,
          padding:"0.9rem",fontSize:"0.88rem",fontWeight:700,cursor:"pointer",
          letterSpacing:"0.08em",boxShadow:"0 6px 24px rgba(28,24,20,0.2)"
        }}>BEGIN ASSESSMENT →</button>
        <p style={{textAlign:"center",fontSize:"0.6rem",color:C.inkXL,marginTop:10,letterSpacing:"0.1em"}}>AI-POWERED · ~12 MINUTES</p>
      </div>
    </div>
  );
}

// ── SECTION INTRO ──────────────────────────────────────────────────────────────
function SecIntro({sec,onGo}) {
  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:`linear-gradient(150deg,#fdf9f3 0%,#f0ebe0 100%)`,
      display:"flex", alignItems:"center", justifyContent:"center", padding:"4vh 24px"
    }}>
      <div style={{maxWidth:"min(520px,92vw)", width:"100%", textAlign:"center"}} className="fu">
        <div style={{width:"100%",height:"clamp(80px,12vh,120px)",borderRadius:16,overflow:"hidden",marginBottom:"2.5vh",border:`1px solid ${sec.color}20`}}>{SecIllus[sec.id]}</div>
        <div style={{fontSize:"0.6rem",letterSpacing:"0.38em",color:sec.color,fontWeight:700,marginBottom:"0.8rem"}}>SECTION {sec.id} OF 5</div>
        <h2 style={{
          fontFamily:"'Playfair Display',serif",
          fontSize:"clamp(1.5rem,4vw,2.4rem)",
          fontWeight:800, color:C.ink, lineHeight:1.1, marginBottom:"0.8rem"
        }}>{sec.title}</h2>
        <p style={{fontSize:"0.85rem",color:C.inkM,lineHeight:1.8,maxWidth:360,margin:"0 auto 2.5vh"}}>{sec.sub}</p>
        <button onClick={onGo} style={{
          background:sec.color, color:"#fff", border:"none", borderRadius:12,
          padding:"0.85rem 2.5rem", fontSize:"0.88rem", fontWeight:700,
          cursor:"pointer", letterSpacing:"0.08em",
          boxShadow:`0 6px 20px ${sec.color}40`
        }}>START SECTION →</button>
      </div>
    </div>
  );
}

// ── QUESTION SCREEN — much bigger, clearer layout ─────────────────────────────
function QScreen({q,qi,total,answers,setAnswer,onNext,onBack,canGo}) {
  const sec = SECS.find(s=>s.id===q.s);
  const typeLabel = {open:"OPEN-ENDED · AI SCORED",rat:"REMOTE ASSOCIATES TEST",likert:"SELF-ASSESSMENT",mcq:"BEHAVIORAL",scenario:"SCENARIO CHALLENGE"}[q.type];
  const secQs = Qs.filter(x=>x.s===q.s);
  const posInSec = secQs.findIndex(x=>x.id===q.id)+1;
  const autoTypes = ["likert","mcq","rat","scenario"];
  const handleSelect = (val) => { setAnswer(val); if(autoTypes.includes(q.type)) setTimeout(()=>onNext(), 320); };

  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:`linear-gradient(170deg,#fdf9f3 0%,#f2ede5 100%)`,
      display:"flex", flexDirection:"column"
    }}>
      {/* Progress bar */}
      <div style={{height:4,background:C.inkXL,flexShrink:0}}>
        <div style={{height:"100%",width:`${(qi+1)/total*100}%`,background:`linear-gradient(to right,${sec.color}90,${sec.color})`,transition:"width .4s ease"}}/>
      </div>

      {/* Top nav bar */}
      <div style={{
        padding:"0.6rem 1.5rem",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        borderBottom:`1px solid ${C.inkXL}50`,
        background:"rgba(253,249,243,0.95)", flexShrink:0
      }}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:10,height:10,borderRadius:"50%",background:sec.color}}/>
          <span style={{fontSize:"0.65rem",fontWeight:700,letterSpacing:"0.22em",color:sec.color}}>{sec.title}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:"0.7rem",color:C.inkL}}>{posInSec} of {secQs.length}</span>
          <span style={{fontSize:"0.75rem",fontWeight:700,color:C.inkM}}>{qi+1}<span style={{color:C.inkXL}}>/{total}</span></span>
        </div>
      </div>

      {/* Question content — scrollable middle section */}
      <div style={{flex:1,overflowY:"auto",padding:"clamp(16px,3vh,36px) clamp(16px,4vw,48px)",display:"flex",justifyContent:"center",alignItems:"flex-start"}}>
        <div style={{width:"100%", maxWidth:"min(700px,95vw)"}} key={q.id} className="fu">

          {/* Question type banner */}
          <div style={{
            width:"100%", height:"clamp(70px,10vh,100px)",
            borderRadius:14, overflow:"hidden", marginBottom:"clamp(14px,2.5vh,24px)",
            background:C.white, border:`1px solid ${sec.color}20`
          }}>
            {q.type==="scenario"
              ? <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:20,background:`linear-gradient(135deg,${sec.color}08,${sec.color}15)`}}>
                  <span style={{fontSize:"clamp(28px,5vw,44px)"}}>{q.scene}</span>
                  <div>
                    <div style={{fontSize:"0.65rem",letterSpacing:"0.3em",color:sec.color,fontWeight:700}}>{q.sceneLabel}</div>
                    <div style={{fontSize:"0.8rem",color:C.inkM,marginTop:4}}>Scenario Challenge</div>
                  </div>
                </div>
              : <div style={{height:"100%",display:"flex",alignItems:"center",padding:"0 1.5rem",background:`linear-gradient(135deg,${sec.color}05,${sec.color}12)`, gap:"1rem"}}>
                  <div style={{width:"clamp(60px,8vw,100px)",flexShrink:0}}>{q.illus}</div>
                  <div style={{borderLeft:`1.5px solid ${sec.color}25`,paddingLeft:"1rem"}}>
                    <div style={{fontSize:"0.6rem",letterSpacing:"0.3em",color:sec.color,fontWeight:700}}>{typeLabel}</div>
                    <div style={{fontSize:"0.78rem",color:C.inkM,marginTop:4,lineHeight:1.5}}>
                      {q.type==="open"?"Evaluated by AI for originality & depth":q.type==="rat"?"Find the single hidden connection":"Respond honestly — no right or wrong"}
                    </div>
                  </div>
                </div>
            }
          </div>

          {/* Question number + type label */}
          <div style={{fontSize:"0.62rem",letterSpacing:"0.28em",color:sec.color,marginBottom:"0.6rem",fontWeight:700}}>
            Q{qi+1} · {typeLabel}
          </div>

          {/* Main question text — LARGE & READABLE */}
          <h2 style={{
            fontFamily:"'Playfair Display',serif",
            fontSize:"clamp(1.15rem,2.4vw,1.65rem)",
            fontWeight:700, color:C.ink, lineHeight:1.5,
            marginBottom:"clamp(14px,2.5vh,28px)"
          }}>{q.text}</h2>

          {/* RAT word chips */}
          {q.type==="rat" && (
            <div style={{display:"flex",gap:10,marginBottom:"1.5rem",flexWrap:"wrap"}}>
              {q.words.map(w=>(
                <div key={w} style={{
                  background:C.white, border:`2.5px solid ${sec.color}60`,
                  borderRadius:10, padding:"0.6rem 1.2rem",
                  fontSize:"clamp(1rem,2vw,1.3rem)", fontWeight:800,
                  color:sec.color, letterSpacing:"0.12em"
                }}>{w}</div>
              ))}
            </div>
          )}

          {/* Hint for open questions */}
          {q.type==="open" && q.hint && (
            <div style={{
              background:`${sec.color}08`, borderLeft:`3px solid ${sec.color}`,
              borderRadius:"0 10px 10px 0", padding:"0.7rem 1rem",
              marginBottom:"1rem", fontSize:"0.82rem", color:sec.color,
              lineHeight:1.7, fontStyle:"italic"
            }}>💡 {q.hint}</div>
          )}

          {/* Open textarea */}
          {q.type==="open" && (
            <>
              <textarea
                value={answers[q.id]||""}
                onChange={e=>setAnswer(e.target.value)}
                placeholder={q.ph}
                rows={7}
                style={{
                  width:"100%", background:C.white,
                  border:`1.5px solid ${C.inkXL}`, borderRadius:12,
                  padding:"1rem", color:C.ink,
                  fontSize:"clamp(0.85rem,1.5vw,1rem)",
                  lineHeight:1.8, resize:"none"
                }}
                onFocus={e=>e.target.style.borderColor=sec.color}
                onBlur={e=>e.target.style.borderColor=C.inkXL}
              />
              <div style={{fontSize:"0.72rem",color:C.inkL,marginTop:6,display:"flex",justifyContent:"space-between"}}>
                <span style={{fontStyle:"italic"}}>More specific & unexpected = higher score</span>
                <span>{(answers[q.id]||"").split("\n").filter(l=>l.trim().length>2).length} ideas</span>
              </div>
            </>
          )}

          {/* MCQ / RAT / Scenario options */}
          {(q.type==="rat"||q.type==="mcq"||q.type==="scenario") && (
            <div style={{display:"flex",flexDirection:"column",gap:"0.6rem"}}>
              {q.options.map((opt,i)=>{
                const val = q.type==="rat" ? opt : i;
                const sel = answers[q.id]===val;
                return (
                  <button key={i} onClick={()=>handleSelect(val)} style={{
                    background:sel?C.white:"rgba(255,255,255,0.65)",
                    border:`1.5px solid ${sel?sec.color:C.inkXL}`,
                    borderRadius:12, padding:"0.85rem 1rem",
                    color:sel?C.ink:C.inkM,
                    fontSize:"clamp(0.82rem,1.4vw,0.95rem)",
                    textAlign:"left", cursor:"pointer",
                    fontWeight:sel?600:400, lineHeight:1.6,
                    display:"flex", alignItems:"flex-start", gap:10,
                    boxShadow:sel?`0 2px 12px ${sec.color}25`:"none",
                    transition:"all .15s"
                  }}>
                    <span style={{
                      flexShrink:0, width:24, height:24, borderRadius:6,
                      background:sel?sec.color:`${sec.color}15`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:"0.65rem", fontWeight:800, color:sel?"#fff":sec.color
                    }}>{String.fromCharCode(65+i)}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          {/* Likert scale */}
          {q.type==="likert" && (
            <div>
              <div style={{display:"flex",gap:"0.6rem",marginBottom:"0.6rem"}}>
                {[1,2,3,4,5].map(v=>{
                  const sel = answers[q.id]===v;
                  const colors=["#e55","#e88","#aaa",`${sec.color}90`,sec.color];
                  return (
                    <button key={v} onClick={()=>handleSelect(v)} style={{
                      flex:1, height:"clamp(52px,8vh,70px)",
                      background:sel?C.white:"rgba(255,255,255,0.6)",
                      border:`1.5px solid ${sel?colors[v-1]:C.inkXL}`,
                      borderRadius:12,
                      color:sel?colors[v-1]:C.inkL,
                      fontSize:"clamp(1.1rem,2.5vw,1.4rem)", fontWeight:700,
                      cursor:"pointer",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      flexDirection:"column", gap:4,
                      boxShadow:sel?`0 2px 12px ${colors[v-1]}30`:"none",
                      transition:"all .15s"
                    }}>
                      {v}
                      {sel && <div style={{width:5,height:5,borderRadius:"50%",background:colors[v-1]}}/>}
                    </button>
                  );
                })}
              </div>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:"0.7rem",color:C.inkL,fontStyle:"italic"}}>Strongly Disagree</span>
                <span style={{fontSize:"0.7rem",color:C.inkL,fontStyle:"italic"}}>Strongly Agree</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{
        padding:"0.75rem 1.5rem",
        borderTop:`1px solid ${C.inkXL}50`,
        background:"rgba(253,249,243,0.97)",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        flexShrink:0
      }}>
        <button onClick={onBack} disabled={qi===0} style={{
          background:"transparent",
          border:`1.5px solid ${C.inkXL}`,
          borderRadius:8, padding:"0.55rem 1rem",
          color:qi===0?C.inkXL:C.inkM,
          cursor:qi===0?"default":"pointer",
          fontSize:"0.78rem", fontWeight:500
        }}>← Back</button>

        {/* Section progress dots */}
        <div style={{display:"flex",gap:6}}>
          {SECS.map(s=>{
            const sQs=Qs.filter(x=>x.s===s.id);
            const active=sQs.some(x=>x.id===q.id);
            const done=sQs.every(x=>{const a=answers[x.id];return a!==undefined&&a!==null&&a!==""});
            return <div key={s.id} style={{width:22,height:3,borderRadius:2,background:done?s.color:active?`${s.color}45`:C.inkXL,transition:"background .3s"}}/>;
          })}
        </div>

        <button onClick={onNext} disabled={!canGo} style={{
          background:canGo?sec.color:C.inkXL,
          border:"none", borderRadius:8,
          padding:"0.55rem 1.2rem",
          color:"#fff",
          cursor:canGo?"pointer":"default",
          fontSize:"0.78rem", fontWeight:700,
          opacity:canGo?1:0.5,
          transition:"all .15s"
        }}>{qi===total-1?"Analyze →":"Next →"}</button>
      </div>
    </div>
  );
}

// ── ANALYZING ─────────────────────────────────────────────────────────────────
function Analyzing() {
  const msgs=["Evaluating ideational fluency…","Measuring associative range…","Calibrating originality scores…","Analyzing cross-domain thinking…","Saving your profile to database…","Composing personalised insights…"];
  const [idx,setIdx]=useState(0);
  useEffect(()=>{const t=setInterval(()=>setIdx(i=>(i+1)%msgs.length),2000);return()=>clearInterval(t);},[]);
  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:`linear-gradient(150deg,#fdf9f3 0%,#ede6da 100%)`,
      display:"flex", alignItems:"center", justifyContent:"center", padding:24
    }}>
      <div style={{textAlign:"center",maxWidth:380}} className="fi">
        <div style={{position:"relative",width:130,height:130,margin:"0 auto 40px"}}>
          {[[65,65,18],[18,18,9],[112,22,7],[22,108,8],[112,104,10],[65,9,6]].map(([x,y,r],i)=>(
            <div key={i} style={{position:"absolute",left:x-r/2,top:y-r/2,width:r,height:r,borderRadius:"50%",background:[C.s1,C.s2,C.s3,C.s4,C.s5,C.gold][i%6],opacity:.25+i*.05,animation:`pulse ${1.8+i*.3}s ease-in-out infinite`,animationDelay:`${i*.2}s`}}/>
          ))}
          <div style={{position:"absolute",inset:28,borderRadius:"50%",border:`1.5px solid ${C.gold}30`,animation:"spinR 10s linear infinite"}}/>
          <div style={{position:"absolute",inset:42,borderRadius:"50%",border:`1.5px solid ${C.gold}50`,animation:"spinR 7s linear infinite reverse"}}/>
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,color:C.gold,opacity:.8}}>✦</div>
          </div>
        </div>
        <div style={{fontSize:"0.6rem",letterSpacing:"0.42em",color:C.gold,marginBottom:12,fontWeight:700}}>AI ANALYSIS IN PROGRESS</div>
        <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:"1.5rem",fontWeight:800,color:C.ink,lineHeight:1.3,marginBottom:10}}>Mapping your<br/>creative signature</h2>
        <p style={{fontSize:"0.82rem",color:C.inkM,lineHeight:1.8,maxWidth:300,margin:"0 auto 24px"}}>Claude is evaluating your open-ended responses for originality, flexibility, and depth.</p>
        <div key={idx} className="fi" style={{fontSize:"0.82rem",color:C.gold,fontStyle:"italic",minHeight:20}}>{msgs[idx]}</div>
      </div>
    </div>
  );
}

// ── DASHBOARD PANELS ───────────────────────────────────────────────────────────
function DashPanel({title, children, style={}}) {
  return (
    <div style={{background:C.white,border:"1.5px solid #c8c4be",borderRadius:6,overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 2px 12px rgba(0,0,0,0.07)",...style}}>
      <div style={{background:C.navy,color:"#fff",fontSize:"0.6rem",fontWeight:700,letterSpacing:"0.14em",textAlign:"center",padding:"5px 10px",textTransform:"uppercase",flexShrink:0}}>{title}</div>
      <div style={{flex:1,minHeight:0,overflow:"hidden"}}>{children}</div>
    </div>
  );
}

function Panel1({cii, profile, dims, aiData}) {
  const r=68, cx=104, cy=90;
  const circ=Math.PI*r;
  const filled=circ*(cii/100);
  const gap=circ-filled;
  const ticks=[0,25,50,75,100];
  const sorted=dims.map((d,i)=>({i,d})).sort((a,b)=>b.d-a.d);
  const top3=sorted.slice(0,3);
  const strengthIcons=["💡","🔗","🎲","🔭","⚙️","🚀"];
  return (
    <div style={{height:"100%",display:"flex"}}>
      <div style={{flex:"0 0 46%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"10px 6px 6px"}}>
        <svg width={208} height={108} style={{overflow:"visible"}}>
          <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={C.inkXL} strokeWidth={13} strokeLinecap="round"/>
          <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={profile.color} strokeWidth={13} strokeLinecap="round" strokeDasharray={`${filled} ${gap}`} style={{transition:"stroke-dasharray 1.5s cubic-bezier(.22,1,.36,1)"}}/>
          {ticks.map(t=>{const angle=Math.PI*(1-t/100);const ix=cx+(r+2)*Math.cos(angle),iy=cy-(r+2)*Math.sin(angle);const ox=cx+(r+9)*Math.cos(angle),oy=cy-(r+9)*Math.sin(angle);const lx=cx+(r+16)*Math.cos(angle),ly=cy-(r+16)*Math.sin(angle);return(<g key={t}><line x1={ix} y1={iy} x2={ox} y2={oy} stroke={C.inkXL} strokeWidth={1}/><text x={lx} y={ly+3} textAnchor="middle" fontSize={7} fill={C.inkL} fontFamily="DM Sans,sans-serif">{t}</text></g>);})}
          <text x={cx} y={cy-16} textAnchor="middle" fontFamily="Playfair Display,serif" fontSize={34} fontWeight={800} fill={profile.color}>{cii}</text>
          <text x={cx} y={cy-3} textAnchor="middle" fontFamily="DM Sans,sans-serif" fontSize={7} fill={C.inkL} letterSpacing="2">CII SCORE</text>
        </svg>
        <div style={{textAlign:"center",marginTop:-4}}>
          <div style={{display:"inline-block",background:`${profile.color}15`,border:`1px solid ${profile.color}40`,borderRadius:18,padding:"2px 9px",marginBottom:3}}><span style={{fontSize:8,fontWeight:700,color:profile.color,letterSpacing:"0.1em"}}>{profile.tag}</span></div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:12,fontWeight:800,color:C.ink,lineHeight:1.2}}>{profile.name}</div>
          {aiData?.persona_type && <div style={{fontSize:8,color:C.gold,fontStyle:"italic",marginTop:2}}>"{aiData.persona_type}"</div>}
        </div>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",padding:"10px 10px 10px 4px",borderLeft:`1px solid ${C.inkXL}40`,gap:6}}>
        <p style={{fontSize:9,color:C.inkM,lineHeight:1.6,marginBottom:2}}>{profile.desc}</p>
        <div style={{fontSize:7.5,color:C.gold,fontWeight:700,letterSpacing:"0.16em",display:"flex",alignItems:"center",gap:3,marginBottom:2}}><span>★</span> TOP STRENGTHS</div>
        {top3.map(({i,d},rank)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:6,background:rank===0?`${DIM.colors[i]}12`:`${DIM.colors[i]}06`,border:`1px solid ${DIM.colors[i]}${rank===0?"35":"18"}`,borderRadius:7,padding:"5px 8px"}}>
            <span style={{fontSize:12,flexShrink:0}}>{strengthIcons[i]}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:8,fontWeight:700,color:DIM.colors[i]}}>{DIM.short[i]}</div>
              <div style={{fontSize:6.5,color:C.inkL,lineHeight:1.2}}>{DIM.descs[i]}</div>
            </div>
            <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:800,color:DIM.colors[i]}}>{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Panel2({dims}) {
  const [hover, setHover] = useState(null);
  const xLabels = ["Q1","Q2","Q3","Q4","Q5","Final"];
  const nX = xLabels.length;
  const seeds = [
    [0.55, 0.72, 0.48, 0.81, 0.63, 1.00],
    [0.80, 0.55, 0.90, 0.62, 0.75, 1.00],
    [0.45, 0.78, 0.60, 0.88, 0.70, 1.00],
    [0.70, 0.50, 0.85, 0.58, 0.90, 1.00],
    [0.60, 0.82, 0.52, 0.74, 0.88, 1.00],
    [0.50, 0.68, 0.78, 0.55, 0.82, 1.00],
  ];
  const lines = dims.map((d,i) => ({
    color: DIM.colors[i], abbr: DIM.abbr[i], fullName: DIM.short[i], score: d,
    pts: seeds[i].map(s => Math.round(Math.min(100, Math.max(4, d * s)))),
  }));
  const avgPts = [47, 52, 49, 53, 50, 50];
  const VW = 320, VH = 170;
  const PL = 28, PR = 12, PT = 10, PB = 28;
  const CW = VW - PL - PR, CH = VH - PT - PB;
  const xPos = xi => PL + (xi / (nX - 1)) * CW;
  const yPos = v  => PT + CH - (v / 100) * CH;
  const toPath = pts => pts.map((v,xi) => `${xi===0?"M":"L"}${xPos(xi).toFixed(1)},${yPos(v).toFixed(1)}`).join(" ");
  const yTicks = [0, 20, 40, 60, 80, 100];
  return (
    <div style={{height:"100%",display:"flex",flexDirection:"column",padding:"6px 8px 4px"}}>
      <div style={{flex:1,minHeight:0,display:"flex",alignItems:"stretch"}}>
        <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" style={{width:"100%",height:"100%",display:"block"}}>
          {yTicks.map(t => (
            <g key={t}>
              <line x1={PL} y1={yPos(t)} x2={VW-PR} y2={yPos(t)} stroke={t===0?"#c8c4be":`${C.inkXL}70`} strokeWidth={t===0?0.8:0.5} strokeDasharray={t===0?"none":"3 3"}/>
              <text x={PL-4} y={yPos(t)+3.5} textAnchor="end" fontSize={8} fill={C.inkL} fontFamily="DM Sans,sans-serif">{t}%</text>
            </g>
          ))}
          {xLabels.map((_,xi) => (<line key={xi} x1={xPos(xi)} y1={PT} x2={xPos(xi)} y2={PT+CH} stroke={`${C.inkXL}40`} strokeWidth={0.4}/>))}
          {xLabels.map((l,xi) => (<text key={xi} x={xPos(xi)} y={VH-PT+5} textAnchor="middle" fontSize={8} fill={C.inkL} fontFamily="DM Sans,sans-serif">{l}</text>))}
          <path d={toPath(avgPts)} fill="none" stroke={C.inkXL} strokeWidth={1} strokeDasharray="5 4" opacity={0.8}/>
          {[...Array(6).keys()].sort((a,b) => (hover===b?1:0)-(hover===a?1:0)).map(i => {
            const ln = lines[i];
            const isHov = hover === i;
            const faded = hover !== null && !isHov;
            return (
              <g key={i} style={{cursor:"pointer"}} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)}>
                <path d={toPath(ln.pts)} fill="none" stroke="transparent" strokeWidth={10}/>
                <path d={toPath(ln.pts)} fill="none" stroke={ln.color} strokeWidth={isHov?2.2:1.3} opacity={faded?0.18:1} strokeLinejoin="round" style={{transition:"opacity .18s,stroke-width .1s"}}/>
                {ln.pts.map((v,xi) => (<circle key={xi} cx={xPos(xi)} cy={yPos(v)} r={isHov?3.2:xi===nX-1?2.5:1.6} fill={ln.color} opacity={faded?0.18:1} stroke={isHov||xi===nX-1?C.white:"none"} strokeWidth={isHov||xi===nX-1?1.2:0}/>))}
              </g>
            );
          })}
          {hover !== null && (() => {
            const ln = lines[hover];
            return (
              <g>
                <rect x={PL} y={PT} width={72} height={22} rx={4} fill={C.white} stroke={ln.color} strokeWidth={0.8} opacity={0.97}/>
                <text x={PL+36} y={PT+8} textAnchor="middle" fontSize={7.5} fontWeight="700" fill={ln.color} fontFamily="DM Sans,sans-serif">{ln.fullName}</text>
                <text x={PL+36} y={PT+16} textAnchor="middle" fontSize={7.5} fill={C.inkM} fontFamily="DM Sans,sans-serif">Score: {ln.score}/100 · vs avg +{ln.score - 50}</text>
              </g>
            );
          })()}
        </svg>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"2px 8px",borderTop:`1px solid ${C.inkXL}40`,paddingTop:4,flexShrink:0}}>
        {lines.map((ln,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",opacity:hover!==null&&hover!==i?0.3:1,transition:"opacity .18s"}}
            onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)}>
            <svg width={18} height={7}><line x1="0" y1="3.5" x2="18" y2="3.5" stroke={ln.color} strokeWidth={1.8}/><circle cx="9" cy="3.5" r="2.2" fill={ln.color}/></svg>
            <span style={{fontSize:7.5,color:C.inkM,flex:1,lineHeight:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ln.fullName}</span>
            <span style={{fontSize:8,fontWeight:700,color:ln.color,flexShrink:0}}>{ln.score}</span>
          </div>
        ))}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:5,marginTop:3}}>
        <svg width={18} height={6}><line x1="0" y1="3" x2="18" y2="3" stroke={C.inkXL} strokeWidth={1} strokeDasharray="4 3"/></svg>
        <span style={{fontSize:7,color:C.inkL}}>Population avg · hover a line to highlight</span>
      </div>
    </div>
  );
}

function Panel3({aiData, dims, profile}) {
  const sorted=dims.map((d,i)=>({i,d})).sort((a,b)=>b.d-a.d);
  const top=sorted[0], low=sorted[sorted.length-1];
  return (
    <div style={{height:"100%",padding:"9px 11px",display:"flex",flexDirection:"column",gap:4,overflowY:"auto"}} className="no-scroll">
      {aiData?.persona_type && (
        <div style={{display:"flex",justifyContent:"flex-end",flexShrink:0}}>
          <div style={{background:`${profile.color}14`,border:`1px solid ${profile.color}35`,borderRadius:10,padding:"2px 8px"}}><span style={{fontSize:7.5,fontWeight:700,color:profile.color,fontStyle:"italic"}}>{aiData.persona_type}</span></div>
        </div>
      )}
      {aiData ? (
        <>
          {aiData.key_insight && (
            <div style={{background:`linear-gradient(120deg,${C.gold}12,${C.gold}05)`,border:`1px solid ${C.gold}45`,borderRadius:7,padding:"6px 9px",flexShrink:0}}>
              <div style={{fontSize:6.5,color:C.gold,fontWeight:700,letterSpacing:"0.18em",marginBottom:2}}>✦ KEY INSIGHT</div>
              <p style={{fontSize:8.5,color:C.ink,lineHeight:1.65,fontStyle:"italic",margin:0}}>{aiData.key_insight}</p>
            </div>
          )}
          <div style={{flexShrink:0,background:"#f8f5f010",border:`1px solid ${C.inkXL}`,borderRadius:7,padding:"6px 9px"}}>
            <div style={{fontSize:6.5,color:C.inkL,fontWeight:700,letterSpacing:"0.16em",marginBottom:4}}>COGNITIVE PROFILE</div>
            <p style={{fontSize:8,color:C.ink,lineHeight:1.78,margin:0}}>{aiData.narrative}</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,flexShrink:0}}>
            <div style={{background:`${C.s3}0c`,border:`1px solid ${C.s3}30`,borderRadius:7,padding:"5px 8px"}}>
              <div style={{display:"flex",alignItems:"center",gap:3,marginBottom:3}}><span style={{fontSize:8,color:C.s3}}>✓</span><span style={{fontSize:6.5,color:C.s3,fontWeight:700,letterSpacing:"0.12em"}}>STRENGTH</span></div>
              <p style={{fontSize:7.5,color:C.inkM,lineHeight:1.5,margin:0}}>{aiData.strengths}</p>
            </div>
            <div style={{background:`${C.s4}08`,border:`1px solid ${C.s4}28`,borderRadius:7,padding:"5px 8px"}}>
              <div style={{display:"flex",alignItems:"center",gap:3,marginBottom:3}}><span style={{fontSize:8,color:C.s4}}>→</span><span style={{fontSize:6.5,color:C.s4,fontWeight:700,letterSpacing:"0.12em"}}>BLIND SPOT</span></div>
              <p style={{fontSize:7.5,color:C.inkM,lineHeight:1.5,margin:0}}>{aiData.blind_spots}</p>
            </div>
          </div>
          {aiData.improvements?.length>0 && (
            <div style={{flexShrink:0}}>
              <div style={{fontSize:6.5,color:C.inkL,fontWeight:700,letterSpacing:"0.16em",marginBottom:4}}>🎯 AI-RECOMMENDED ACTIONS</div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                {aiData.improvements.slice(0,3).map((imp,idx)=>{
                  const di=imp.dim??idx;
                  const color=DIM.colors[di]||C.s2;
                  return(
                    <div key={idx} style={{display:"flex",gap:5,alignItems:"center",background:`${color}08`,border:`1px solid ${color}22`,borderRadius:6,padding:"4px 7px"}}>
                      <div style={{width:14,height:14,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:6.5,fontWeight:800,color:"#fff",flexShrink:0}}>{idx+1}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:6.5,color,fontWeight:700,marginBottom:1}}>{DIM.short[di]}</div>
                        <p style={{fontSize:7.5,color:C.inkM,lineHeight:1.4,margin:0}}>{imp.action}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,flexShrink:0}}>
            <div style={{background:`${DIM.colors[top.i]}0e`,border:`1px solid ${DIM.colors[top.i]}30`,borderRadius:7,padding:"6px 8px"}}>
              <div style={{fontSize:6.5,color:DIM.colors[top.i],fontWeight:700,letterSpacing:"0.12em",marginBottom:2}}>↑ STRONGEST</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:800,color:DIM.colors[top.i],lineHeight:1,marginBottom:2}}>{top.d}</div>
              <div style={{fontSize:7.5,fontWeight:700,color:C.ink,marginBottom:1}}>{DIM.short[top.i]}</div>
              <div style={{fontSize:7,color:C.inkL,lineHeight:1.35}}>{DIM.descs[top.i]}</div>
            </div>
            <div style={{background:`${DIM.colors[low.i]}0e`,border:`1px solid ${DIM.colors[low.i]}30`,borderRadius:7,padding:"6px 8px"}}>
              <div style={{fontSize:6.5,color:DIM.colors[low.i],fontWeight:700,letterSpacing:"0.12em",marginBottom:2}}>↓ GROWTH AREA</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,fontWeight:800,color:DIM.colors[low.i],lineHeight:1,marginBottom:2}}>{low.d}</div>
              <div style={{fontSize:7.5,fontWeight:700,color:C.ink,marginBottom:1}}>{DIM.short[low.i]}</div>
              <div style={{fontSize:7,color:C.inkL,lineHeight:1.35}}>{DIM.descs[low.i]}</div>
            </div>
          </div>
          <div style={{flexShrink:0,background:`${C.ink}03`,border:`1px solid ${C.inkXL}`,borderRadius:7,padding:"8px 10px"}}>
            <div style={{fontSize:6.5,color:C.inkL,fontWeight:700,letterSpacing:"0.14em",marginBottom:6}}>DIMENSION SPREAD · vs population average</div>
            {dims.map((d,i)=>{
              const avg=[45,55,50,48,42,52][i];
              const diff=d-avg;
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                  <span style={{fontSize:7,color:C.inkL,width:28,flexShrink:0,textAlign:"right",lineHeight:1}}>{DIM.abbr[i]}</span>
                  <div style={{flex:1,position:"relative",height:8,background:`${DIM.colors[i]}15`,borderRadius:4,overflow:"hidden"}}>
                    <div style={{position:"absolute",top:0,bottom:0,left:0,width:`${d}%`,background:`linear-gradient(to right,${DIM.colors[i]}80,${DIM.colors[i]})`,borderRadius:4,transition:"width 1s ease"}}/>
                    <div style={{position:"absolute",top:0,bottom:0,left:`${avg}%`,width:1.5,background:C.inkM,opacity:0.5}}/>
                  </div>
                  <span style={{fontSize:7.5,fontWeight:800,color:DIM.colors[i],width:22,textAlign:"right",flexShrink:0}}>{d}</span>
                  <span style={{fontSize:6.5,fontWeight:600,color:diff>=0?C.s3:C.s4,width:24,flexShrink:0,textAlign:"left"}}>{diff>=0?`+${diff}`:`${diff}`}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Panel4({dims, cii, profile}) {
  const avgBenchmark=[45,55,50,48,42,52];
  const radarData=DIM.names.map((n,i)=>({subject:DIM.abbr[i],score:dims[i],avg:avgBenchmark[i],fullMark:100}));
  const sorted=[...dims.map((d,i)=>({i,d}))].sort((a,b)=>b.d-a.d);
  const top2=sorted.slice(0,2);
  const low1=sorted[sorted.length-1];
  const low2=sorted.slice(-2);
  const avg=Math.round(dims.reduce((s,d)=>s+d,0)/dims.length);
  const aboveAvg=dims.filter((d,i)=>d>avgBenchmark[i]).length;
  const DIM_TIPS=[
    ["Write 30 uses for a pen daily to build fluency","Try SCAMPER on a product you use every day","10-min 'random word + problem' sprints"],
    ["Read one unrelated-field article each week","Connect 3 random nouns in one sentence daily","Keep a 'pattern journal' of cross-domain links"],
    ["Take one small professional risk this week","Practice 'Yes, and…' in your next meeting","Defend a view you disagree with for 5 min"],
    ["Write a 3-year vision letter in present tense","Set one goal with purely intrinsic motivation","Map the world if your best idea fully succeeded"],
    ["Ship one small creative output every 7 days","Redesign one broken process in your life now","Track creative output daily — streaks compound"],
    ["Study one famous company pivot and extract why","Ask 'What if opposite were true?' on projects","Spend 20 min on a problem that feels unsolvable"],
  ];
  const dimIcons=["💡","🔗","🎲","🔭","⚙️","🚀"];
  const percentileText={"Top 5%":"Top 5%","Top 20%":"Top 20%","Above Average":"Top 35%","Average":"Top 50%","Developing":"Bottom 50%"}[profile.tag]||profile.tag;
  const shapeType=(()=>{const t=top2.map(x=>x.i);if(t.includes(0)&&t.includes(1))return{label:"Idea Generator",desc:"Strong at producing and connecting novel ideas rapidly."};if(t.includes(2)&&t.includes(3))return{label:"Bold Visionary",desc:"High tolerance for risk combined with strong future-thinking."};if(t.includes(4)&&t.includes(5))return{label:"Creative Executor",desc:"Translates creative thinking into real-world action."};if(t.includes(3)&&t.includes(5))return{label:"Innovation Driver",desc:"Vision + bold scenario thinking — you drive new directions."};if(t.includes(0)&&t.includes(5))return{label:"Creative Maverick",desc:"Divergent thinker who approaches hard problems unconventionally."};return{label:"Balanced Creator",desc:"Relatively even creative profile across all dimensions."};})();
  const CustomTooltip=({active,payload})=>{if(!active||!payload?.length) return null;const subj=payload[0]?.payload?.subject;const idx=DIM.abbr.indexOf(subj);const your=payload.find(p=>p.dataKey==="score")?.value;const avgV=payload.find(p=>p.dataKey==="avg")?.value;const diff=your-avgV;return(<div style={{background:C.white,border:`1px solid ${C.inkXL}`,borderRadius:7,padding:"6px 9px",fontSize:8.5,boxShadow:"0 3px 10px rgba(0,0,0,0.1)",minWidth:120}}><div style={{fontWeight:700,color:idx>=0?DIM.colors[idx]:C.ink,marginBottom:3}}>{idx>=0?DIM.short[idx]:subj}</div><div style={{color:C.inkL}}>You: <b style={{color:idx>=0?DIM.colors[idx]:C.ink}}>{your}</b> · Avg: <b>{avgV}</b> · <b style={{color:diff>=0?C.s3:C.s4}}>{diff>=0?"+":""}{diff}</b></div></div>);};
  return (
    <div style={{display:"flex",height:"100%"}}>
      <div style={{width:148,flexShrink:0,display:"flex",flexDirection:"column",padding:"1px 2px",borderRight:`1px solid ${C.inkXL}50`,overflowY:"auto",gap:0,fontSize:"0.9em"}}className="no-scroll">
        <div style={{marginBottom:8}}>
          <div style={{fontSize:7,color:C.inkL,letterSpacing:"0.1em",marginBottom:1}}>OVERALL CII SCORE</div>
          <div style={{display:"flex",alignItems:"baseline",gap:4}}><div style={{fontFamily:"'Playfair Display',serif",fontSize:30,fontWeight:800,color:profile.color,lineHeight:1}}>{cii}</div><div style={{fontSize:7.5,color:C.inkL}}>/100</div></div>
          <div style={{display:"flex",gap:3,marginTop:3,flexWrap:"wrap"}}>
            <div style={{background:`${profile.color}15`,border:`1px solid ${profile.color}35`,borderRadius:9,padding:"1px 6px"}}><span style={{fontSize:7,fontWeight:700,color:profile.color}}>{percentileText}</span></div>
            <div style={{background:`${C.inkXL}50`,borderRadius:9,padding:"1px 6px"}}><span style={{fontSize:7,color:C.inkM}}>Avg {avg}</span></div>
            <div style={{background:`${C.s3}15`,border:`1px solid ${C.s3}30`,borderRadius:9,padding:"1px 6px"}}><span style={{fontSize:7,color:C.s3,fontWeight:600}}>{aboveAvg}/6 above avg</span></div>
          </div>
        </div>
        <div style={{background:`${profile.color}08`,border:`1px solid ${profile.color}25`,borderRadius:6,padding:"6px 8px",marginBottom:8}}>
          <div style={{fontSize:7,color:profile.color,fontWeight:700,letterSpacing:"0.1em",marginBottom:2}}>◈ CREATIVE SHAPE</div>
          <div style={{fontSize:9.5,fontWeight:700,color:C.ink,marginBottom:1}}>{shapeType.label}</div>
          <p style={{fontSize:7.5,color:C.inkM,lineHeight:1.5}}>{shapeType.desc}</p>
        </div>
        <div style={{borderTop:`1px dashed ${C.inkXL}`,paddingTop:7,marginBottom:7}}>
          <div style={{fontSize:7,color:C.inkL,letterSpacing:"0.1em",marginBottom:5}}>TOP DIMENSIONS</div>
          {top2.map(({i,d})=>(<div key={i} style={{marginBottom:6}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:1.5}}><span style={{fontSize:8,color:DIM.colors[i],fontWeight:700}}>{DIM.short[i]}</span><span style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:800,color:DIM.colors[i]}}>{d}</span></div><div style={{height:2.5,background:`${DIM.colors[i]}18`,borderRadius:2,overflow:"hidden",marginBottom:1.5}}><div style={{height:"100%",width:`${d}%`,background:DIM.colors[i],borderRadius:2,transition:"width 1.2s cubic-bezier(.22,1,.36,1)"}}/></div><div style={{fontSize:6.5,color:d>avgBenchmark[i]?C.s3:C.s4,textAlign:"right"}}>{d>avgBenchmark[i]?"+":""}{d-avgBenchmark[i]} vs avg</div></div>))}
        </div>
        <div style={{borderTop:`1px dashed ${C.inkXL}`,paddingTop:7,marginBottom:7}}>
          <div style={{fontSize:7,color:C.inkL,letterSpacing:"0.1em",marginBottom:5}}>GROWTH EDGE</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:1.5}}><span style={{fontSize:8,color:DIM.colors[low1.i],fontWeight:700}}>{DIM.short[low1.i]}</span><span style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:800,color:DIM.colors[low1.i]}}>{low1.d}</span></div>
          <div style={{height:2.5,background:`${DIM.colors[low1.i]}18`,borderRadius:2,overflow:"hidden",marginBottom:1.5}}><div style={{height:"100%",width:`${low1.d}%`,background:DIM.colors[low1.i],borderRadius:2}}/></div>
          <div style={{fontSize:6.5,color:C.s4,textAlign:"right"}}>{low1.d-avgBenchmark[low1.i]} vs avg</div>
        </div>
        <div style={{borderTop:`1px dashed ${C.inkXL}`,paddingTop:7}}>
          <div style={{fontSize:7,color:C.inkL,letterSpacing:"0.1em",marginBottom:5}}>ALL DIMENSIONS</div>
          {dims.map((d,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}><div style={{width:5,height:5,borderRadius:"50%",background:DIM.colors[i],flexShrink:0}}/><span style={{fontSize:7,color:C.inkM,flex:1}}>{DIM.abbr[i]}</span><div style={{width:30,height:2.5,background:`${DIM.colors[i]}18`,borderRadius:1,overflow:"hidden"}}><div style={{width:`${d}%`,height:"100%",background:DIM.colors[i],borderRadius:1}}/></div><span style={{fontSize:7,fontWeight:700,color:DIM.colors[i],width:18,textAlign:"right"}}>{d}</span><span style={{fontSize:6,color:d>avgBenchmark[i]?C.s3:C.s4,width:16,textAlign:"right",fontWeight:600}}>{d>avgBenchmark[i]?"+":""}{d-avgBenchmark[i]}</span></div>))}
        </div>
      </div>
      <div style={{flex:"0 0 40%",display:"flex",flexDirection:"column",borderRight:`1px solid ${C.inkXL}30`}}>
        <div style={{flex:1,minHeight:0}}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} margin={{top:16,right:28,bottom:12,left:28}}>
              <PolarGrid stroke={`${C.inkXL}80`} strokeDasharray="3 3"/>
              <PolarAngleAxis dataKey="subject" tick={{fill:C.inkL,fontSize:8,fontFamily:"'DM Sans',sans-serif"}}/>
              <Radar name="Pop. Avg" dataKey="avg" stroke={C.inkXL} fill={C.inkXL} fillOpacity={0.2} strokeWidth={1.2} strokeDasharray="4 3"/>
              <Radar name="Your Score" dataKey="score" stroke={profile.color} fill={profile.color} fillOpacity={0.18} strokeWidth={2.2}/>
              <Tooltip content={<CustomTooltip/>}/>
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div style={{display:"flex",justifyContent:"center",gap:14,padding:"4px 10px 6px",borderTop:`1px solid ${C.inkXL}30`}}>
          <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:14,height:2,background:profile.color}}/><span style={{fontSize:7.5,color:C.inkM}}>You</span></div>
          <div style={{display:"flex",alignItems:"center",gap:4}}><svg width={14} height={4}><line x1="0" y1="2" x2="14" y2="2" stroke={C.inkXL} strokeWidth={1.2} strokeDasharray="3 2"/></svg><span style={{fontSize:7.5,color:C.inkM}}>Avg</span></div>
        </div>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",padding:"8px 10px",gap:8,overflowY:"auto"}}>
        {low2.map(({i,d})=>{const color=DIM.colors[i];const tips=DIM_TIPS[i];const pct=Math.round(d);const diff=avgBenchmark[i]-d;return(<div key={i} style={{flex:1,border:`1.5px solid ${color}40`,borderRadius:10,overflow:"hidden",display:"flex",background:C.white,minHeight:0}}><div style={{width:100,flexShrink:0,background:`linear-gradient(160deg,${color}20,${color}08)`,borderRight:`1px solid ${color}30`,padding:"10px 9px",display:"flex",flexDirection:"column",justifyContent:"center",gap:4}}><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:13}}>{dimIcons[i]}</span><span style={{fontSize:8,fontWeight:800,color,lineHeight:1.1}}>{DIM.short[i]}</span></div><div style={{fontSize:6.5,color:C.inkL,lineHeight:1.3}}>{DIM.descs[i]}</div><div><div style={{display:"flex",alignItems:"baseline",gap:2,marginBottom:3}}><span style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:800,color,lineHeight:1}}>{pct}</span><span style={{fontSize:6.5,color:C.inkL}}>/100</span></div><div style={{height:4,background:`${color}18`,borderRadius:3,overflow:"hidden",position:"relative",marginBottom:2}}><div style={{position:"absolute",inset:0,width:`${pct}%`,background:`linear-gradient(to right,${color}80,${color})`,borderRadius:3}}/><div style={{position:"absolute",top:0,bottom:0,left:`${avgBenchmark[i]}%`,width:1.5,background:C.inkM,opacity:0.5}}/></div><div style={{fontSize:6.5,fontWeight:700,color:diff>0?C.s4:C.s3}}>{diff>0?`↓ ${diff} below avg`:`↑ ${-diff} above avg`}</div></div></div><div style={{flex:1,padding:"10px 11px",display:"flex",flexDirection:"column",justifyContent:"center",gap:7}}><div style={{fontSize:6.5,color:C.inkL,fontWeight:700,letterSpacing:"0.12em"}}>PRACTICE ACTIONS</div>{tips.slice(0,2).map((tip,ti)=>(<div key={ti} style={{display:"flex",gap:7,alignItems:"flex-start"}}><div style={{width:16,height:16,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7.5,fontWeight:800,color:"#fff",flexShrink:0,marginTop:1}}>{ti+1}</div><p style={{fontSize:8,color:C.ink,lineHeight:1.45,margin:0}}>{tip}</p></div>))}</div></div>);})}
      </div>
    </div>
  );
}

function Panel5({dims, profile}) {
  const cx=100,cy=100;
  const rings=DIM.short.map((name,i)=>({name,score:dims[i],color:DIM.colors[i],r:28+i*13}));
  return (
    <div style={{display:"flex",height:"100%"}}>
      <div style={{flex:"0 0 54%",display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 0 6px 6px"}}>
        <svg width={196} height={196} viewBox="0 0 200 200">
          {rings.map(({r,color,score},i)=>{const circ=2*Math.PI*r;const filled=circ*(score/100);const gap=circ-filled;return(<g key={i}><circle cx={cx} cy={cy} r={r} fill="none" stroke={`${color}20`} strokeWidth={8}/><circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${filled} ${gap}`} transform={`rotate(-90 ${cx} ${cy})`} opacity={0.85} style={{transition:`stroke-dasharray ${1+i*0.15}s cubic-bezier(.22,1,.36,1)`}}/></g>);})}
          <text x={cx} y={cy-5} textAnchor="middle" fontFamily="Playfair Display,serif" fontSize={12} fontWeight={800} fill={profile.color}>CII</text>
          <text x={cx} y={cy+9} textAnchor="middle" fontFamily="Playfair Display,serif" fontSize={18} fontWeight={800} fill={profile.color}>{Math.round(dims.reduce((s,d,i)=>s+d*DIM.weights[i],0))}</text>
        </svg>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",padding:"10px 8px 10px 4px",borderLeft:`1px solid ${C.inkXL}40`,gap:6}}>
        <div style={{fontSize:7,color:C.inkL,letterSpacing:"0.12em",fontWeight:600,marginBottom:1}}>EACH RING = ONE DIMENSION</div>
        {rings.map((d,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:8,height:8,borderRadius:"50%",background:d.color,flexShrink:0,border:`2px solid ${d.color}40`}}/><span style={{fontSize:8,color:C.inkM,flex:1}}>{d.name}</span><div style={{width:28,height:3,background:`${d.color}20`,borderRadius:2,overflow:"hidden"}}><div style={{width:`${d.score}%`,height:"100%",background:d.color}}/></div><span style={{fontSize:8,fontWeight:700,color:d.color,width:20,textAlign:"right"}}>{d.score}</span></div>))}
        <div style={{borderTop:`1px dashed ${C.inkXL}`,paddingTop:6,marginTop:1}}>
          <div style={{fontSize:7,color:C.inkL,marginBottom:3}}>PROFILE SCALE</div>
          {PROFILES.map(p=>(<div key={p.name} style={{display:"flex",alignItems:"center",gap:3,marginBottom:2,opacity:profile.name===p.name?1:0.28}}><div style={{width:4,height:4,borderRadius:"50%",background:p.color,flexShrink:0}}/><span style={{fontSize:6.5,color:profile.name===p.name?p.color:C.inkM,fontWeight:profile.name===p.name?700:400}}>{p.range} · {p.name}</span></div>))}
        </div>
      </div>
    </div>
  );
}

// ── RESULTS SCREEN ─────────────────────────────────────────────────────────────
function Results({results, aiData, userInfo, userId, sessionId, onRetake}) {
  const {dims, cii} = results;
  const profile = getProfile(cii);
  const [downloading, setDownloading] = useState(false);
  const [saveStatus, setSaveStatus]   = useState("idle");
  const dashboardRef = React.useRef(null);

  useEffect(() => {
    if (!sessionId || !userId) return;
    const timer = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        const canvas = await captureDashboard(dashboardRef.current);
        await dbSaveDashboardExport(sessionId, userId, canvas);
        setSaveStatus("saved");
      } catch(e) {
        setSaveStatus("error:" + e.message);
        console.error("[Results] Full error:", e);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [sessionId, userId]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const canvas = await captureDashboard(dashboardRef.current);
      const link = document.createElement("a");
      link.download = `CII-Results-${userInfo?.name?.split(" ")[0] || "Report"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch(e) { console.error("[Download] Failed:", e); }
    setDownloading(false);
  };


  return (
    <div
      ref={dashboardRef}
      style={{
        height:"100dvh", width:"100vw",
        background:"#edeae4",
        padding:"2px 8px 2px",
        gap:4,
        overflow:"hidden",
        display:"flex", flexDirection:"column"
      }}
      className="fi"
    >
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <div>
          <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:"clamp(0.95rem,1.5vw,1.2rem)",fontWeight:800,color:C.ink,lineHeight:1.2}}>
            Creative Innovation Index
            {userInfo?.name && <span style={{color:C.gold}}> — {userInfo.name}</span>}
          </h1>
          <p style={{fontSize:"clamp(0.65rem,0.9vw,0.8rem)",color:C.inkL,marginTop:3}}>
            {userInfo?.designation && userInfo?.organization ? `${userInfo.designation} · ${userInfo.organization} · ` : ""}
            Multi-dimensional psychometric assessment · AI-evaluated · 6 creativity dimensions
          </p>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={handleDownload} disabled={downloading} style={{background:C.gold,border:"none",borderRadius:5,padding:"5px 12px",color:"#fff",fontSize:"0.6rem",cursor:downloading?"default":"pointer",fontWeight:600,letterSpacing:"0.08em",whiteSpace:"nowrap"}}>
            {downloading ? "⏳ Capturing…" : "⬇ DOWNLOAD"}
          </button>
          <button onClick={onRetake} style={{background:"transparent",border:`1.5px solid ${C.inkXL}`,borderRadius:5,padding:"5px 12px",color:C.inkM,fontSize:"0.6rem",cursor:"pointer",fontWeight:600,letterSpacing:"0.08em",whiteSpace:"nowrap"}}>↩ RETAKE</button>
        </div>
      </div>

      {/* Top 3 panels */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"clamp(4px,0.8vw,10px)",flex:"0 0 auto",height:"calc(48vh - 40px)"}}>
        <DashPanel title="CII Score — Gauge & Strengths"><Panel1 cii={cii} profile={profile} dims={dims} aiData={aiData}/></DashPanel>
        <DashPanel title="Dimension Score Lines"><Panel2 dims={dims}/></DashPanel>
        <DashPanel title="Analysis"><Panel3 aiData={aiData} dims={dims} profile={profile}/></DashPanel>
      </div>

      {/* Bottom 2 panels */}
      <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:"clamp(4px,0.8vw,10px)",flex:"0 0 auto",height:"calc(54vh - 40px)"}}>
        <DashPanel title="Creative Profile Radar · Improvement Actions"><Panel4 dims={dims} cii={cii} profile={profile}/></DashPanel>
        <DashPanel title="Dimension Progress Rings"><Panel5 dims={dims} profile={profile}/></DashPanel>
      </div>

      {/* Footer */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <p style={{fontSize:"0.55rem",color:C.inkL,fontStyle:"italic"}}>Scores are AI-evaluated.</p>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {PROFILES.map(p=>(<div key={p.name} style={{display:"flex",alignItems:"center",gap:3,opacity:profile.name===p.name?1:0.3}}><div style={{width:6,height:6,borderRadius:"50%",background:p.color}}/><span style={{fontSize:"0.5rem",color:p.color,fontWeight:profile.name===p.name?700:400}}>{p.name}</span></div>))}
        </div>
      </div>
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────────────────────────
export default function CII() {
  const [screen,    setScreen]    = useState("welcome");
  const [qi,        setQi]        = useState(0);
  const [showIntro, setShowIntro] = useState(false);
  const [answers,   setAnswers]   = useState({});
  const [results,   setResults]   = useState(null);
  const [aiData,    setAiData]    = useState(null);
  const [userInfo,  setUserInfo]  = useState(null);
  const [userId,    setUserId]    = useState(null);
  const [sessionId, setSessionId] = useState(null);

  const userIdRef    = React.useRef(null);
  const sessionIdRef = React.useRef(null);
  const answersRef   = React.useRef({});

  useEffect(()=>{
    const el=document.createElement("style");
    el.textContent=CSS;
    document.head.appendChild(el);
    return()=>document.head.removeChild(el);
  },[]);

  const q   = Qs[qi];
  const sec = q ? SECS.find(s=>s.id===q.s) : null;

  const canGo = useMemo(()=>{
    if(!q) return false;
    const a = answers[q.id];
    if(q.type==="open") return typeof a==="string" && a.trim().length>3;
    return a !== undefined && a !== null && a !== "";
  },[q, answers]);

  const setAnswer = v => {
    setAnswers(prev => {
      const next = {...prev, [q.id]: v};
      answersRef.current = next;
      return next;
    });
  };

  const handleUserDetailsSubmit = async (info, uId) => {
    setUserInfo(info);
    setUserId(uId);
    userIdRef.current = uId;

    let sId = genId();
    try {
      const sess = await dbCreateSession(uId);
      if (sess?.id) sId = sess.id;
    } catch(e) { console.warn("[App] Session create failed:", e.message); }
    setSessionId(sId);
    sessionIdRef.current = sId;

    setScreen("test");
    setShowIntro(true);
  };

  const next = async () => {
    if (qi < Qs.length - 1) {
      const nextSec = SECS.find(s=>s.id===Qs[qi+1].s);
      const curSec  = SECS.find(s=>s.id===q.s);
      if (nextSec.id !== curSec.id) setShowIntro(true);
      setQi(i=>i+1);
    } else {
      setScreen("analyzing");
      const currentAnswers = answersRef.current;
      const sId = sessionIdRef.current;
      const uId = userIdRef.current;

      const openAns = Qs.filter(x=>x.type==="open").map(x=>currentAnswers[x.id]||"");
      const prelim  = computeScore(currentAnswers, null);

      let finalAi  = null;
      let finalRes = null;

      try {
        const ai = await scoreWithAI(openAns, prelim.dims, currentAnswers);
        finalAi  = ai;
        finalRes = computeScore(currentAnswers, ai._divScores);
      } catch(e) {
        console.warn("[App] AI scoring failed, using local scores:", e.message);
        finalRes = computeScore(currentAnswers, null);
      }

      if (sId && uId) {
        try { await dbSaveAnswers(sId, currentAnswers); } catch(e) { console.error("[App] dbSaveAnswers failed:", e.message); }
        try { await dbSaveResults(sId, uId, finalRes, finalAi, userInfo); } catch(e) { console.error("[App] dbSaveResults failed:", e.message); }
      }

      setResults(finalRes);
      setAiData(finalAi);
      setScreen("results");
    }
  };

  const back = () => { if(qi>0) setQi(i=>i-1); };

  const retake = () => {
    userIdRef.current    = null;
    sessionIdRef.current = null;
    answersRef.current   = {};
    setScreen("welcome"); setQi(0); setAnswers({}); setResults(null);
    setAiData(null); setUserInfo(null); setUserId(null); setSessionId(null); setShowIntro(false);
  };

  if (screen==="welcome")     return <Welcome onStart={()=>setScreen("userDetails")}/>;
  if (screen==="userDetails") return <UserDetailsForm onSubmit={handleUserDetailsSubmit}/>;
  if (screen==="analyzing")   return <Analyzing/>;
  if (screen==="results")     return <Results results={results} aiData={aiData} userInfo={userInfo} userId={userId} sessionId={sessionId} onRetake={retake}/>;
  if (showIntro && sec)       return <SecIntro sec={sec} onGo={()=>setShowIntro(false)}/>;
  return <QScreen q={q} qi={qi} total={Qs.length} answers={answers} setAnswer={setAnswer} onNext={next} onBack={back} canGo={canGo}/>;
}


// ============================================================
// SUPABASE SQL SCHEMA
// ============================================================
/*

CREATE TABLE IF NOT EXISTS cii_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  designation   TEXT,
  organization  TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cii_sessions (
  id            TEXT PRIMARY KEY,
  user_id       UUID REFERENCES cii_users(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  status        TEXT DEFAULT 'in_progress'
);

CREATE TABLE IF NOT EXISTS cii_answers (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT REFERENCES cii_sessions(id) ON DELETE CASCADE,
  question_id   TEXT NOT NULL,
  answer_value  TEXT NOT NULL,
  saved_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cii_results (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT REFERENCES cii_sessions(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES cii_users(id) ON DELETE CASCADE,
  cii_score       INTEGER,
  profile_name    TEXT,
  profile_tag     TEXT,
  dim_divergent   INTEGER,
  dim_assoc       INTEGER,
  dim_risk        INTEGER,
  dim_vision      INTEGER,
  dim_behavior    INTEGER,
  dim_innovation  INTEGER,
  ai_narrative    TEXT,
  ai_key_insight  TEXT,
  ai_strengths    TEXT,
  ai_blind_spots  TEXT,
  ai_persona_type TEXT,
  ai_improvements TEXT,
  completed_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cii_dashboard_exports (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT REFERENCES cii_sessions(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES cii_users(id) ON DELETE CASCADE,
  file_url     TEXT NOT NULL,
  exported_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE cii_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cii_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cii_answers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cii_results           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cii_dashboard_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_insert_users"    ON cii_users    FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_users"    ON cii_users    FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_users"    ON cii_users    FOR UPDATE TO anon USING (true);
CREATE POLICY "anon_insert_sessions" ON cii_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_sessions" ON cii_sessions FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_sessions" ON cii_sessions FOR UPDATE TO anon USING (true);
CREATE POLICY "anon_insert_answers"  ON cii_answers  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_answers"  ON cii_answers  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_results"  ON cii_results  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_results"  ON cii_results  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_exports"  ON cii_dashboard_exports FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_exports"  ON cii_dashboard_exports FOR SELECT TO anon USING (true);

*/ 