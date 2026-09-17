const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";
const REGION = "europe-west1";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_CARDS = 40;
const MAX_QUIZ_QUESTIONS = 15;
const MAX_WRITING_PROMPTS = 15;

function fail(res, status, msg) {
  res.status(status).json({ ok: false, msg });
  return null;
}

async function requireAuth(req, res) {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return fail(res, 403, "Accès non autorisé.");
  }
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);

    // Pour restreindre l'accès à des comptes précis, décommente et complète :
    // if (!["maxime@...", "ruben@..."].includes(decoded.email)) {
    //   return fail(res, 403, "Accès non autorisé.");
    // }

    return { uid: decoded.uid, email: decoded.email };
  } catch (err) {
    console.error("verifyIdToken failed", err);
    return fail(res, 403, "Accès non autorisé.");
  }
}

function extractToolInput(message, toolName) {
  const block = message.content.find(
    (c) => c.type === "tool_use" && c.name === toolName
  );
  return block ? block.input : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

exports.generateSet = onRequest(
  { region: REGION, secrets: [ANTHROPIC_API_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      return fail(res, 405, "Méthode non autorisée.");
    }
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { imageBase64, mimeType, subject, context } = req.body || {};
    if (!isNonEmptyString(imageBase64)) {
      return fail(res, 400, "Image manquante.");
    }
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      return fail(res, 400, "Format d'image non supporté.");
    }

    const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const tool = {
      name: "submit_flashcard_set",
      description:
        "Soumet un set de fiches de révision, un quiz et des exercices d'écriture générés à partir de la photo d'un exercice scolaire.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          subject: { type: "string" },
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                front: { type: "string" },
                back: { type: "string" },
              },
              required: ["front", "back"],
            },
          },
          quiz: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                choices: {
                  type: ["array", "null"],
                  items: { type: "string" },
                },
                answer: { type: "string" },
              },
              required: ["question", "answer"],
            },
          },
          writing: {
            type: "array",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                referenceAnswer: { type: "string" },
              },
              required: ["prompt", "referenceAnswer"],
            },
          },
        },
        required: ["title", "subject", "cards", "quiz", "writing"],
      },
    };

    const hints = [
      subject ? `Matière indiquée par l'utilisateur : ${subject}.` : null,
      context ? `Contexte additionnel : ${context}.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: "tool", name: "submit_flashcard_set" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: cleanBase64,
                },
              },
              {
                type: "text",
                text: `Regarde cette photo d'un exercice scolaire (probablement en allemand ou dans une autre matière). Génère un set de fiches de révision recto/verso, un petit quiz, et si pertinent des exercices d'écriture avec une réponse de référence. ${hints} Réponds uniquement via l'outil submit_flashcard_set.`,
              },
            ],
          },
        ],
      });

      const data = extractToolInput(message, "submit_flashcard_set");
      if (!data || !Array.isArray(data.cards) || !Array.isArray(data.quiz)) {
        return fail(res, 502, "Réponse IA invalide, réessaie.");
      }

      const cards = data.cards
        .filter((c) => isNonEmptyString(c.front) && isNonEmptyString(c.back))
        .slice(0, MAX_CARDS)
        .map((c) => ({ front: c.front.trim(), back: c.back.trim() }));

      if (cards.length === 0) {
        return fail(res, 502, "Réponse IA invalide, réessaie.");
      }

      const quiz = data.quiz
        .filter((q) => isNonEmptyString(q.question) && isNonEmptyString(q.answer))
        .slice(0, MAX_QUIZ_QUESTIONS)
        .map((q) => ({
          question: q.question.trim(),
          choices: Array.isArray(q.choices) ? q.choices : null,
          answer: q.answer.trim(),
        }));

      const writing = Array.isArray(data.writing)
        ? data.writing
            .filter(
              (w) =>
                isNonEmptyString(w.prompt) && isNonEmptyString(w.referenceAnswer)
            )
            .slice(0, MAX_WRITING_PROMPTS)
            .map((w) => ({
              prompt: w.prompt.trim(),
              referenceAnswer: w.referenceAnswer.trim(),
            }))
        : [];

      res.status(200).json({
        ok: true,
        data: {
          title: isNonEmptyString(data.title) ? data.title.trim() : "Nouveau set",
          subject: isNonEmptyString(data.subject) ? data.subject.trim() : "Général",
          cards,
          quiz,
          writing,
        },
      });
    } catch (err) {
      console.error("generateSet failed", err);
      return fail(res, 502, "L'IA n'a pas pu générer le set, réessaie.");
    }
  }
);

exports.checkWriting = onRequest(
  { region: REGION, secrets: [ANTHROPIC_API_KEY] },
  async (req, res) => {
    if (req.method !== "POST") {
      return fail(res, 405, "Méthode non autorisée.");
    }
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const { answerText, referenceAnswer, prompt } = req.body || {};
    if (!isNonEmptyString(answerText) || !isNonEmptyString(referenceAnswer)) {
      return fail(res, 400, "Réponse ou référence manquante.");
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const tool = {
      name: "submit_grading",
      description:
        "Soumet la correction d'une réponse écrite, avec un score, un verdict et un retour constructif en français.",
      input_schema: {
        type: "object",
        properties: {
          correct: { type: "boolean" },
          score: { type: "number" },
          feedback: { type: "string" },
          corrections: { type: "string" },
        },
        required: ["correct", "score", "feedback"],
      },
    };

    try {
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        tools: [tool],
        tool_choice: { type: "tool", name: "submit_grading" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Tu es un correcteur exigeant mais bienveillant. ${
                  prompt ? `Exercice : ${prompt}` : ""
                }\nRéponse de référence : ${referenceAnswer}\nRéponse de l'élève : ${answerText}\nÉvalue la réponse de l'élève (tolère les petites fautes d'accent ou de frappe pour un crédit partiel), donne un score de 0 à 100, et un retour court, énergique et constructif en français. Réponds uniquement via l'outil submit_grading.`,
              },
            ],
          },
        ],
      });

      const data = extractToolInput(message, "submit_grading");
      if (
        !data ||
        typeof data.correct !== "boolean" ||
        typeof data.score !== "number" ||
        !isNonEmptyString(data.feedback)
      ) {
        return fail(res, 502, "Réponse IA invalide, réessaie.");
      }

      res.status(200).json({
        ok: true,
        data: {
          correct: data.correct,
          score: Math.max(0, Math.min(100, Math.round(data.score))),
          feedback: data.feedback.trim(),
          corrections: isNonEmptyString(data.corrections)
            ? data.corrections.trim()
            : undefined,
        },
      });
    } catch (err) {
      console.error("checkWriting failed", err);
      return fail(res, 502, "L'IA n'a pas pu corriger la réponse, réessaie.");
    }
  }
);
