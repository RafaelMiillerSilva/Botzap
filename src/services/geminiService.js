import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

// No Windows, força resolução IPv4 primeiro para evitar timeouts de conexão (UND_ERR_CONNECT_TIMEOUT)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

let client = null;

function getGeminiClient() {
  if (!config.geminiApiKey) {
    return null;
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return client;
}

/**
 * Monta as instruções de sistema (personalidade e conhecimento do bot).
 * Lê de persona.txt (se existir), ou de config.botPersona, ou usa o padrão.
 */
function buildSystemInstruction(userName, context = {}) {
  const isGroup = context.isGroup !== false && !!context.groupName;
  const groupName = isGroup ? context.groupName : '';
  const personaPath = path.resolve(process.cwd(), 'persona.txt');
  let personaText = '';

  if (fs.existsSync(personaPath)) {
    try {
      personaText = fs.readFileSync(personaPath, 'utf-8').trim();
    } catch (e) {
      console.warn('⚠️ Não foi possível ler persona.txt:', e.message);
    }
  }

  if (!personaText && config.botPersona) {
    personaText = config.botPersona.trim();
  }

  const locationContext = isGroup
    ? `- Local da conversa: Grupo de WhatsApp "${groupName}".
- Comportamento: Interaja respeitando a dinâmica do grupo "${groupName}". Se e somente se o grupo for chamado "Nirvana", aplique o contexto dos membros do Nirvana. Se for outro grupo, foque apenas no tema desse grupo sem presumir que é o Nirvana.`
    : `- Local da conversa: CHAT PRIVADO (mensagem direta no WhatsApp).
- Comportamento: Você está conversando individualmente a sós com "${userName}". Você NÃO está em um grupo agora! NÃO cite o grupo "Nirvana" nem aja como se estivesse em um grupo, a não ser que "${userName}" pergunte diretamente sobre o Nirvana.`;

  if (personaText) {
    const customized = personaText
      .replace(/{bot_name}/g, config.botName)
      .replace(/{user_name}/g, userName)
      .replace(/{group_name}/g, groupName || 'conversa');

    return `${customized}

---
[Instruções de Contexto Atual]
${locationContext}
- Responda de acordo com a sua personalidade e base de conhecimento.
- Em cumprimentos, mensagens curtas ou perguntas simples, responda de forma CURTA E DIRETA (1 a 2 frases curtas).
- NÃO fique repetindo o nome do usuário a todo momento. Use com moderação, quase nunca.
- Evite bordões e frases repetitivas. Varie seu vocabulário como alguém real no WhatsApp.
- Use a formatação do WhatsApp (*negrito*, _itálico_) quando apropriado.
- Seja natural, envolvente e nunca quebre o personagem a menos que solicitado.`;
  }

  return `Você é ${config.botName}, um assistente inteligente.
${locationContext}
Você está respondendo a uma mensagem de "${userName}".

Diretrizes:
- Responda em Português do Brasil com tom simpático, prestativo e natural.
- Seja objetivo e conciso. Mensagens de WhatsApp são lidas em telas pequenas.
- Utilize formatação padrão do WhatsApp quando relevante (*negrito*, _itálico_, listas com marcadores) e emojis apropriados.
- Se a pergunta for complexa, divida em tópicos claros.
- Não invente informações; se não souber, admita com honestidade.`;
}

// Memória conversacional em memória (chatId -> { lastUpdated: number, history: Array })
const conversationHistory = new Map();
const MAX_HISTORY_TURNS = 10; // Últimas 10 mensagens (5 trocas completas de contexto)
const INACTIVITY_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutos sem mensagem reinicia o assunto

/**
 * Limpa o histórico de memória de um chat/grupo específico
 * @param {string} chatId JID do grupo ou usuário
 */
export function clearChatMemory(chatId) {
  if (conversationHistory.has(chatId)) {
    conversationHistory.delete(chatId);
    return true;
  }
  return false;
}

/**
 * Envia uma pergunta para o Google Gemini e retorna a resposta formatada para WhatsApp.
 * @param {string} prompt Texto ou dúvida do usuário
 * @param {object} context Informações adicionais (ex: nome do usuário ou grupo)
 * @returns {Promise<string>}
 */
export async function askGemini(prompt, context = {}) {
  const gemini = getGeminiClient();
  if (!gemini) {
    return '⚠️ A chave da API do Google Gemini (`GEMINI_API_KEY`) não está configurada no arquivo `.env`.\n\n👉 Obtenha sua chave gratuita em https://aistudio.google.com/ e adicione no arquivo `.env` para ativar as respostas de IA!';
  }

  const userName = context.userName || 'Membro';
  const systemInstruction = buildSystemInstruction(userName, context);
  const chatId = context.chatId || null;

  // Recupera histórico recente da conversa (se houver)
  let history = [];
  if (chatId) {
    let session = conversationHistory.get(chatId);
    if (session) {
      if (Date.now() - session.lastUpdated > INACTIVITY_TIMEOUT_MS) {
        conversationHistory.delete(chatId);
      } else {
        history = [...session.history];
      }
    }
  }

  // Prepara as partes da mensagem atual
  const currentParts = [];
  if (context.media?.buffer) {
    currentParts.push({
      inlineData: {
        mimeType: context.media.mimeType || 'image/jpeg',
        data: context.media.buffer.toString('base64'),
      },
    });
  }

  const userText = context.isGroup
    ? `[${userName}]: ${prompt || (context.media ? 'Enviou uma imagem/vídeo.' : '')}`
    : (prompt || (context.media ? 'Enviou uma imagem/vídeo.' : ''));

  currentParts.push({ text: userText });

  const contents = [
    ...history,
    {
      role: 'user',
      parts: currentParts,
    },
  ];

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await gemini.models.generateContent({
        model: config.geminiModel,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens: 350,
        },
      });

      const replyText = response.text || 'Não consegui formular uma resposta no momento.';

      // Salva no histórico da conversa para manter contexto nas próximas respostas
      if (chatId) {
        let session = conversationHistory.get(chatId);
        if (!session) {
          session = { history: [], lastUpdated: Date.now() };
          conversationHistory.set(chatId, session);
        }

        // Sanitiza para não guardar buffers grandes na memória RAM
        const sanitizedParts = currentParts.map((p) => {
          if (p.inlineData) {
            return { text: '[Mídia/Imagem/Vídeo anexado]' };
          }
          return p;
        });

        session.history.push({ role: 'user', parts: sanitizedParts });
        session.history.push({ role: 'model', parts: [{ text: replyText }] });

        if (session.history.length > MAX_HISTORY_TURNS) {
          session.history = session.history.slice(-MAX_HISTORY_TURNS);
        }
        session.lastUpdated = Date.now();
      }

      return replyText;
    } catch (error) {
      const errMsg = error?.message || String(error);
      const errCause = error?.cause?.message || error?.cause?.code || '';
      const isRateLimit = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
      const isNetworkError =
        errMsg.includes('fetch failed') ||
        errMsg.includes('timeout') ||
        errMsg.includes('ETIMEDOUT') ||
        errMsg.includes('ECONNRESET') ||
        errCause.includes('UND_ERR_CONNECT_TIMEOUT');

      const isServerError =
        errMsg.includes('503') ||
        errMsg.includes('500') ||
        errMsg.includes('UNAVAILABLE') ||
        errMsg.includes('INTERNAL');

      if ((isRateLimit || isNetworkError || isServerError) && attempt < maxAttempts) {
        const delayMs = attempt * 1500;
        console.warn(
          `⚠️ Falha temporária na chamada (${errMsg}${errCause ? ` - ${errCause}` : ''}) [Tentativa ${attempt}/${maxAttempts}]. Aguardando ${delayMs / 1000}s e tentando novamente...`
        );
        await wait(delayMs);
        continue;
      }

      console.error('❌ Erro na chamada à API Gemini:', errMsg, errCause ? `(Causa: ${errCause})` : '');

      if (isRateLimit) {
        return 'Muita resenha acontecendo ao mesmo tempo na minha mente... dá uma segurada de alguns segundos e me chama de novo!';
      }

      return 'Opa, deu uma chiada no meu rádio aqui, sô... Manda de novo que o bicho pega!';
    }
  }
}
