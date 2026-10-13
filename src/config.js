import dotenv from 'dotenv';
dotenv.config();

export const config = {
  botName: process.env.BOT_NAME || 'ZapBot',
  botPrefix: process.env.BOT_PREFIX || '!',
  
  // Google Gemini AI
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  
  // Moderação
  antiLink: process.env.ANTI_LINK === 'true' || process.env.ANTI_LINK === undefined,
  
  // Boas-vindas e regras
  welcomeEnabled: process.env.WELCOME_ENABLED === 'true' || process.env.WELCOME_ENABLED === undefined,
  welcomeMessage: process.env.WELCOME_MESSAGE || '👋 Olá @user! Seja muito bem-vindo(a) ao grupo *{group_name}*!',
  groupRules: process.env.GROUP_RULES || '📜 *Regras do Grupo:*\n1. Respeite todos os participantes.\n2. Proibido spam ou links não autorizados.',
  
  // Agendador
  scheduleEnabled: process.env.SCHEDULE_ENABLED === 'true',
  scheduleCron: process.env.SCHEDULE_CRON || '0 9 * * *',
  scheduleTargetGroup: process.env.SCHEDULE_TARGET_GROUP || '',
  scheduleMessage: process.env.SCHEDULE_MESSAGE || '☀️ *Bom dia, pessoal!* Desejamos um ótimo dia a todos!',
};

// Configurações dinâmicas por grupo (em memória durante execução)
export const groupState = {
  antiLinkStatus: new Map(), // groupId -> boolean
  isAntiLinkEnabled(groupId) {
    if (this.antiLinkStatus.has(groupId)) {
      return this.antiLinkStatus.get(groupId);
    }
    return config.antiLink;
  },
  setAntiLink(groupId, enabled) {
    this.antiLinkStatus.set(groupId, enabled);
  }
};
