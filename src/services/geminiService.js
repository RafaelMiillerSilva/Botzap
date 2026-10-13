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

  try {
    const userName = context.userName || 'Membro';
    const groupName = context.groupName || 'Grupo WhatsApp';

    const systemInstruction = `Você é ${config.botName}, um assistente de inteligência artificial integrado a um grupo de WhatsApp chamado "${groupName}".
Você está respondendo a uma mensagem de "${userName}".

Diretrizes:
- Responda em Português do Brasil com tom simpático, prestativo e natural.
- Seja objetivo e conciso. Mensagens de WhatsApp são lidas em telas pequenas.
- Utilize formatação padrão do WhatsApp quando relevante (*negrito*, _itálico_, listas com marcadores) e emojis apropriados.
- Se a pergunta for complexa, divida em tópicos claros.
- Não invente informações; se não souber, admita com honestidade.`;

    const interaction = await gemini.interactions.create({
      model: config.geminiModel,
      input: prompt,
      system_instruction: systemInstruction,
    });

    return interaction.output_text || '🤖 Não consegui formular uma resposta no momento. Tente reformular sua pergunta!';
  } catch (error) {
    console.error('❌ Erro na chamada à API Gemini:', error?.message || error);
    return `❌ Erro ao consultar a IA: ${error?.message || 'Falha de comunicação com o serviço.'}`;
  }
}
