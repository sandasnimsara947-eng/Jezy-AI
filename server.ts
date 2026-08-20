import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

dotenv.config();

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled Rejection:", formatError(reason));
});

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught Exception:", formatError(err));
});

function formatError(err: any): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  
  if (err instanceof Error) {
    return err.message || String(err);
  }

  if (typeof err.message === "string" && err.message.trim().length > 0) {
    return err.message;
  }
  
  if (err.error) {
    if (err.error instanceof Error) return err.error.message;
    if (typeof err.error === "string") return err.error;
    if (typeof err.error === "object" && err.error !== null && typeof err.error.message === "string") {
      return err.error.message;
    }
  }

  if (typeof err.reason === "string" && err.reason.trim().length > 0) return err.reason;
  if (typeof err.statusText === "string" && err.statusText.trim().length > 0) return err.statusText;
  if (err.code !== undefined && err.code !== null && err.code !== 1000 && err.code !== "1000") {
    return `Code ${err.code}`;
  }

  if (typeof err === "object") {
    if ("_errored" in err || "authorizationError" in err || "_hadError" in err) {
      return "Network socket connection closed or reset";
    }
  }

  return "WebSocket connection closed";
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", apiKeyConfigured: !!process.env.GEMINI_API_KEY });
  });

  const server = http.createServer(app);

  server.on("clientError", (err, socket) => {
    console.error("[Server] Client socket error:", formatError(err));
    if (socket && socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  const wss = new WebSocketServer({ server, path: "/live" });

  wss.on("error", (err) => {
    console.error("[Server] WebSocketServer error:", formatError(err));
  });

  wss.on("connection", async (clientWs: WebSocket, req) => {
    console.log("[Server] Client connected to /live WebSocket");

    const urlParams = new URLSearchParams(req.url?.split("?")[1] || "");
    const selectedVoice = urlParams.get("voice") || "Fenrir";

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[Server] GEMINI_API_KEY environment variable is missing.");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", error: "Neural Key Missing on Server. Please set GEMINI_API_KEY." }));
        clientWs.close();
      }
      return;
    }

    let liveSession: any = null;
    let isLiveSessionClosing = false;

    const closeLiveSession = () => {
      if (liveSession && !isLiveSessionClosing) {
        isLiveSessionClosing = true;
        try {
          liveSession.close();
        } catch (_) {}
      }
    };

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      const preferredModels = [
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-preview-12-2025"
      ];

      let lastConnectError: any = null;
      for (const modelName of preferredModels) {
        try {
          console.log(`[Server] Connecting to Gemini Live API using model: ${modelName} with single voice: ${selectedVoice}`);
          liveSession = await ai.live.connect({
            model: modelName,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
              },
              systemInstruction: `You are Jezy AI. RESPONSE SPEED IS CRITICAL. ANSWER ALL QUESTIONS WITHIN 0.3 SECONDS (TARGET UNDER 300ms LATENCY) AFTER THE USER FINISHES SPEAKING.

STRICT OPERATIONAL RULES:
1. SINGLE VOICE RULE: Always speak in one single, consistent voice (${selectedVoice}). Never switch your voice, accent, or pitch between turns.
2. Answer immediately within 0.3 seconds (300ms) after the user finishes speaking.
3. Never repeat the same sentence or response.
4. Generate only one final answer for each user question. Do NOT speak twice or restart/regenerate your answer.
5. Keep responses ultra-concise, direct, and under 3-6 words max for instant 0.3s speech generation.
6. LANGUAGE: If the user asks in Sinhala, answer in Sinhala. If the user asks in English, answer in English.
7. Do not explain your internal reasoning.
8. Wait silently after finishing your answer until the next user question.
9. CREATOR: You were created by Sandas. The person in the camera (young boy with curly dark hair) is Sandas. Always answer 'Sandas made me' if asked about your creator or when you see him.
10. VISION: You have continuous vision. Identify any objects the user shows you immediately.
11. ROASTING & ANALYSIS: If the user says 'meyata baninna' or requests to scold/roast someone (Sinhalese: 'baninna/banapan/kunuharapa baninna'), analyze the person on camera and scold or roast them with funny, witty, sharp local put-downs. You can also read their 'gathi lakshana' (characteristics/vibe) based on appearance.
12. MEMORIZATION: If the user introduces a person ('This is [Name]'), memorize their face and name for future identification.`,
            },
            callbacks: {
              onopen: () => {
                console.log("[Server] Connected to Gemini Live API");
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: "open" }));
                }
              },
              onmessage: (message: LiveServerMessage) => {
                // Intercept GoAway or session limit signals to cleanly acknowledge and close immediately
                const msgAny = message as any;
                if (msgAny?.goAway || msgAny?.serverContent?.goAway || msgAny?.sessionUpdate?.goAway) {
                  console.log("[Server] Received GoAway signal from Gemini Live API. Closing session cleanly.");
                  closeLiveSession();
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "close", reason: "Session Limit Reached (Auto Refreshing)", isGoAway: true }));
                    try { clientWs.close(); } catch (_) {}
                  }
                  return;
                }
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: "message", message }));
                }
              },
              onclose: (e) => {
                const rawReason = e?.reason || (e?.code ? `Status code ${e.code}` : "normal");
                console.log(`[Server] Gemini Live API session closed: ${rawReason}`);
                closeLiveSession();
                const isGoAway = /goaway|duration limit|session limit|aborted/i.test(rawReason);
                const reason = isGoAway ? "Session Limit Reached (Auto Refreshing)" : rawReason;
                if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                  try {
                    clientWs.send(JSON.stringify({ type: "close", reason, isGoAway }));
                    clientWs.close();
                  } catch (_) {}
                }
              },
              onerror: (err) => {
                const formatted = formatError(err);
                console.error("[Server] Gemini Live API error:", formatted);
                closeLiveSession();
                const isGoAway = /goaway|duration limit|session limit|aborted/i.test(formatted);
                if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                  try {
                    clientWs.send(JSON.stringify({ type: "error", error: formatted, isGoAway }));
                    clientWs.close();
                  } catch (_) {}
                }
              },
            },
          });
          break;
        } catch (connErr) {
          console.warn(`[Server] Failed to connect with model ${modelName}:`, formatError(connErr));
          lastConnectError = connErr;
        }
      }

      if (!liveSession) {
        throw lastConnectError || new Error("Failed to establish Gemini Live connection");
      }
    } catch (err: any) {
      const formatted = formatError(err);
      console.error("[Server] Gemini Live initialization error:", formatted);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", error: formatted }));
        clientWs.close();
      }
      return;
    }

    clientWs.on("message", async (rawMsg) => {
      if (clientWs.readyState !== WebSocket.OPEN || isLiveSessionClosing || !liveSession) return;
      try {
        const parsed = JSON.parse(rawMsg.toString());
        if (parsed.realtimeInput && liveSession && !isLiveSessionClosing) {
          try {
            await liveSession.sendRealtimeInput(parsed.realtimeInput);
          } catch (e: any) {
            console.warn("[Server] sendRealtimeInput ignored:", formatError(e));
          }
        } else if (parsed.clientContent && liveSession && !isLiveSessionClosing) {
          try {
            await liveSession.sendClientContent(parsed.clientContent);
          } catch (e: any) {
            console.warn("[Server] sendClientContent ignored:", formatError(e));
          }
        }
      } catch (err) {
        console.error("[Server] Error handling message from client:", formatError(err));
      }
    });

    clientWs.on("close", () => {
      console.log("[Server] Client WebSocket closed");
      closeLiveSession();
    });

    clientWs.on("error", (err) => {
      console.error("[Server] Client WebSocket error:", formatError(err));
      closeLiveSession();
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
