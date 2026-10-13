import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

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

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await gemini.models.generateContent({
        model: config.geminiModel,
        contents: prompt,
        config: {
          systemInstruction,
          maxOutputTokens: 350,
        },
      });

      return response.text || 'Não consegui formular uma resposta no momento.';
    } catch (error) {
      const errMsg = error?.message || String(error);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit && attempt === 1) {
        console.warn('⚠️ Limite temporário da API (429) atingido. Aguardando 2 segundos e tentando novamente...');
        await wait(2000);
        continue;
      }

      console.error('❌ Erro na chamada à API Gemini:', errMsg);

      if (isRateLimit) {
        return 'Muita resenha acontecendo ao mesmo tempo na minha mente... dá uma segurada de alguns segundos e me chama de novo!';
      }

      return 'Tive uma breve interferência aqui nas sombras... tenta me mandar de novo daqui a pouco!';
    }
  }
}
