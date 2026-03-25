import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { openAnswers } = req.body;

  const labeled = [
    "Q1 (Uses for a broken umbrella)",
    "Q2 (Sideways gravity consequences)",
    "Q3 (Silence as a resource)",
    "Q4 (Traffic solutions from different fields)",
    "Q5 (No-rules school design)",
  ]
    .map((label, i) => `${label}:\n${openAnswers[i] || "(no answer provided)"}`)
    .join("\n\n");

  const prompt = `You are an expert creativity researcher scoring divergent thinking responses for a psychometric assessment.

Evaluate each response on four criteria:
- Originality: How unexpected and non-obvious are the ideas?
- Fluency: How many distinct, valid ideas are present?
- Flexibility: How many different categories or domains are covered?
- Elaboration: How well-developed and specific are the ideas?

SCORING GUIDE (be honest and calibrated):
- 0–30: Below average — generic, few ideas, predictable
- 31–50: Average — reasonable ideas, mostly obvious
- 51–70: Above average — some genuinely surprising ideas, decent variety
- 71–85: Strong — multiple unexpected ideas, good cross-domain range
- 86–100: Exceptional — rare. Requires genuinely surprising, well-developed, specific ideas

Most people score between 35–60. Reserve 80+ for responses that are demonstrably unusual.

Return ONLY valid JSON (no markdown, no extra text outside the JSON):
{
  "scores": [score_q1, score_q2, score_q3, score_q4, score_q5],
  "narrative": "2–3 paragraphs of genuinely analytical, personalized insight about this person's creative thinking style. Reference their actual ideas. Avoid generic praise — be specific and honest about patterns you notice.",
  "strengths": "1–2 specific sentences about their actual creative strengths based on their answers.",
  "blind_spots": "1–2 honest, constructive sentences about where their thinking is limited or conventional."
}

${labeled}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    res.status(200).json(parsed);
  } catch (err) {
    console.error("Scoring error:", err);
    res.status(500).json({ error: "Scoring failed" });
  }
}