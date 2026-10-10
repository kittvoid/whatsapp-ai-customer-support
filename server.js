require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 3000;

// -------------------------
// Configuration
// -------------------------
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// -------------------------
// Local in-memory session memory
// Keep last 6 alternating messages per phone number.
// Structure: { phoneNumber: [ {role: 'user'|'assistant', content: '...'}, ... ] }
// -------------------------
const sessionMemory = new Map();

// -------------------------
// Helpers
// -------------------------
function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/\s+/g, "").replace(/[^\d+]/g, "");
}

function getOrCreateSession(phoneNumber) {
  if (!sessionMemory.has(phoneNumber)) {
    sessionMemory.set(phoneNumber, []);
  }
  return sessionMemory.get(phoneNumber);
}

function appendToSession(phoneNumber, role, content) {
  const history = getOrCreateSession(phoneNumber);
  history.push({ role, content: String(content).trim() });

  // Keep only last 6 alternating messages to preserve context
  if (history.length > 6) {
    history.splice(0, history.length - 6);
  }
}

function buildHistoryForGemini(phoneNumber) {
  const history = getOrCreateSession(phoneNumber);
  const geminiHistory = [];

  for (const item of history) {
    geminiHistory.push({
      role: item.role === "user" ? "user" : "model",
      parts: [{ text: item.content }],
    });
  }

  return geminiHistory;
}

// -------------------------
// Mock outbound WhatsApp sender
// Simulates sending final AI text to WhatsApp Business API.
// -------------------------
async function sendWhatsAppMessage(recipientPhone, textResponse) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(recipientPhone),
    type: "text",
    text: {
      body: textResponse,
    },
  };

  try {
    const response = await axios({
      method: "post",
      url: "https://graph.facebook.com/v19.0/104000000000000/messages",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN || "MOCK_TOKEN"}`,
        "Content-Type": "application/json",
      },
      data: payload,
      timeout: 10000,
    });

    return response.data;
  } catch (error) {
    console.error("WhatsApp send failed:", error.response?.data || error.message);
    return {
      status: "mocked",
      message: "Outbound message stubbed successfully.",
      recipientPhone,
      textResponse,
    };
  }
}

// -------------------------
// WhatsApp webhook verification
// -------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully.");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed.");
  }

  return res.status(400).send("Missing verification parameters.");
});

// -------------------------
// WhatsApp incoming message handler
// -------------------------
app.use(express.json({ limit: "1mb" }));

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!body || !body.entry || !Array.isArray(body.entry)) {
      return res.status(400).json({ status: "error", message: "Invalid WhatsApp payload." });
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];

        for (const message of messages) {
          const from = message.from;
          const type = message.type;

          if (!from || type !== "text") continue;

          const senderPhone = normalizePhone(from);
          const senderName =
            value.contacts && value.contacts[0] && value.contacts[0].profile
              ? value.contacts[0].profile.name
              : "Customer";

          const textBody = message.text && message.text.body ? message.text.body.trim() : "";

          if (!textBody) continue;

          // Save user input to session memory
          appendToSession(senderPhone, "user", textBody);

          // Build conversation history for Gemini
          const chatHistory = buildHistoryForGemini(senderPhone);

          let aiResponse = "Thank you for your message. Our team will get back to you shortly.";

          try {
            const model = genai.getGenerativeModel({ model: "gemini-2.5-flash" });

            const chat = model.startChat({
              history: chatHistory,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 250,
              },
              systemInstruction:
                "You are a helpful, professional, and warm AI customer relations assistant for a retail and logistics brand based in Lagos, Nigeria. Answer questions concisely. Use natural Nigerian English customer-service etiquette where appropriate (e.g., greeting customers with politeness, understanding local context, and handling price inquiries gracefully). Keep answers under 3 sentences.",
            });

            const result = await chat.sendMessage(textBody);
            aiResponse = result.response.text().trim() || "Thank you for reaching out. We're here to help.";
          } catch (geminiError) {
            console.error("Gemini API call failed:", geminiError.message);

            aiResponse =
              "Sorry, our support assistant is temporarily unavailable. Please try again in a moment or contact our team directly.";
          }

          // Save assistant response to session memory
          appendToSession(senderPhone, "assistant", aiResponse);

          // Simulate outbound send to WhatsApp
          try {
            await sendWhatsAppMessage(senderPhone, aiResponse);
          } catch (sendError) {
            console.error("sendWhatsAppMessage failed:", sendError.message);
          }

          console.log(`Handled message from ${senderName} (${senderPhone}): "${textBody}"`);
        }
      }
    }

    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).json({
      status: "error",
      message: "Webhook processing failed.",
      fallback:
        "Sorry, our support assistant is temporarily unavailable. Please try again in a moment.",
    });
  }
});

// -------------------------
// Health check
// -------------------------
app.get("/", (req, res) => {
  res.status(200).json({
    service: "WhatsApp AI customer support agent (Gemini powered)",
    status: "online",
    port,
  });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
