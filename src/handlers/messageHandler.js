import { downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { config, groupState } from '../config.js';
import { askGemini, clearChatMemory } from '../services/geminiService.js';

const mediaLogger = pino({ level: 'silent' });

// Armazena os IDs das mensagens enviadas pelo próprio bot (para detecção precisa de citação/reply)
const botSentMessageIds = new Set();

function rememberBotSentMessage(msgId) {
  if (!msgId) return;
  botSentMessageIds.add(msgId);
  // Mantém no máximo 500 mensagens na memória
  if (botSentMessageIds.size > 500) {
    const firstKey = botSentMessageIds.values().next().value;
    botSentMessageIds.delete(firstKey);
  }
}

/**
 * Envia mensagem pelo socket Baileys e registra o ID da mensagem para detecção de citações futuras
 */
async function sendBotMessage(sock, jid, content, options = {}) {
  const result = await sock.sendMessage(jid, content, options);
  if (result?.key?.id) {
    rememberBotSentMessage(result.key.id);
  }
  return result;
}

/**
 * Desencapsula mensagens que vêm dentro de wrappers do WhatsApp (efêmeras, view-once, caption)
 */
function normalizeMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return normalizeMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return normalizeMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return normalizeMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return normalizeMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return normalizeMessage(message.documentWithCaptionMessage.message);
  return message;
}

/**
 * Extrai apenas o número / identificador bruto de um JID (sem :dispositivo e sem @servidor)
 */
function getRawId(jid) {
  if (!jid) return '';
  return jid.split(':')[0].replace(/@.*/, '');
}

/**
 * Limpa o JID preservando o domínio original (@s.whatsapp.net ou @lid) e removendo sufixo de dispositivo (:1, :2, etc.)
 */
function cleanJid(jid) {
  if (!jid) return '';
  const [userAndDevice, server] = jid.split('@');
  const user = userAndDevice.split(':')[0];
  return server ? `${user}@${server}` : user;
}

/**
 * Obtém os identificadores (telefone e LID) do próprio bot
 */
function getBotIdentifiers(sock) {
  const me = sock?.user || sock?.authState?.creds?.me || {};
  const phoneJid = me.id || '';
  const lidJid = me.lid || '';

  const rawPhone = getRawId(phoneJid);
  const rawLid = getRawId(lidJid);

  return {
    rawPhone,
    rawLid,
    phoneJid: rawPhone ? `${rawPhone}@s.whatsapp.net` : '',
    lidJid: rawLid ? `${rawLid}@lid` : '',
  };
}

/**
 * Verifica se um determinado JID pertence ao bot (seja pelo número de telefone ou pelo LID do WhatsApp)
 */
function isBotJid(jid, sock) {
  if (!jid) return false;
  const raw = getRawId(jid);
  if (!raw) return false;

  const bot = getBotIdentifiers(sock);
  return Boolean(
    (bot.rawPhone && raw === bot.rawPhone) ||
    (bot.rawLid && raw === bot.rawLid)
  );
}

/**
 * Baixa mídia (imagem ou vídeo) da mensagem atual ou de uma mensagem citada
 */
async function extractMedia(sock, msg) {
  const m = normalizeMessage(msg.message);
  const contextInfo =
    m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo ||
    m?.stickerMessage?.contextInfo;

  // 1. Mídia na própria mensagem recebida
  if (m?.imageMessage || m?.videoMessage || m?.stickerMessage) {
    const isVideo = !!m.videoMessage;
    const isSticker = !!m.stickerMessage;
    const mediaMsg = m.imageMessage || m.videoMessage || m.stickerMessage;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: mediaLogger,
            reuploadRequest: (updateMsg) => sock.updateMediaMessage(updateMsg),
          }
        );
        if (buffer) {
          return {
            buffer,
            mimeType: mediaMsg.mimetype || (isVideo ? 'video/mp4' : (isSticker ? 'image/webp' : 'image/jpeg')),
            type: isVideo ? 'video' : (isSticker ? 'sticker' : 'image'),
          };
        }
      } catch (err) {
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        console.warn('⚠️ Falha ao baixar mídia direta:', err?.message);
      }
    }
  }

  // 2. Mídia na mensagem citada (reply)
  const quoted = normalizeMessage(contextInfo?.quotedMessage);
  if (quoted?.imageMessage || quoted?.videoMessage || quoted?.stickerMessage) {
    const isVideo = !!quoted.videoMessage;
    const isSticker = !!quoted.stickerMessage;
    const mediaMsg = quoted.imageMessage || quoted.videoMessage || quoted.stickerMessage;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const fakeMsg = {
          key: {
            remoteJid: msg.key.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
          },
          message: quoted,
        };
        const buffer = await downloadMediaMessage(
          fakeMsg,
          'buffer',
          {},
          {
            logger: mediaLogger,
            reuploadRequest: (updateMsg) => sock.updateMediaMessage(updateMsg),
          }
        );
        if (buffer) {
          return {
            buffer,
            mimeType: mediaMsg.mimetype || (isVideo ? 'video/mp4' : (isSticker ? 'image/webp' : 'image/jpeg')),
            type: isVideo ? 'video' : (isSticker ? 'sticker' : 'image'),
          };
        }
      } catch (err) {
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        console.warn('⚠️ Falha ao baixar mídia citada:', err?.message);
      }
    }
  }

  return null;
}

// Regex para identificar links de sites, grupos e WhatsApp
const LINK_REGEX = /((https?:\/\/)|(www\.)|(chat\.whatsapp\.com\/)|(wa\.me\/))[^\s]+/gi;

/**
 * Extrai o texto limpo da mensagem do Baileys
 */
function extractMessageText(msg) {
  const m = normalizeMessage(msg?.message);
  if (!m) return '';

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

/**
 * Resume o conteúdo textual ou tipo de mídia de uma mensagem citada (quotedMessage)
 */
function getQuotedMessageSummary(quotedMessage) {
  if (!quotedMessage) return '';
  const m = normalizeMessage(quotedMessage);
  if (!m) return '';

  const text = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();

  if (text) return text;
  if (m.stickerMessage) return '[Figurinha/Sticker]';
  if (m.imageMessage) return '[Foto/Imagem]';
  if (m.videoMessage) return '[Vídeo]';
  if (m.audioMessage) return '[Áudio]';
  return '';
}

/**
 * Verifica se um participante é administrador no grupo (compatível com LID e telefone)
 */
function isParticipantAdmin(participants, participantJid, sock) {
  if (!Array.isArray(participants) || !participantJid) return false;
  const targetRaw = getRawId(participantJid);
  const isTargetBot = sock ? isBotJid(participantJid, sock) : false;

  const found = participants.find((p) => {
    const pRaw = getRawId(p.id);
    if (pRaw && pRaw === targetRaw) return true;
    if (isTargetBot && sock && isBotJid(p.id, sock)) return true;
    return false;
  });

  return found ? found.admin === 'admin' || found.admin === 'superadmin' : false;
}

/**
 * Trata as mensagens recebidas via WhatsApp
 * @param {object} sock Instância do socket Baileys
 * @param {object} m Objeto do evento messages.upsert
 */
export async function handleIncomingMessages(sock, m) {
  const rawMsg = m.messages?.[0];
  if (!rawMsg || !rawMsg.message) return;

  // Ignora mensagens de status/stories
  if (rawMsg.key.remoteJid === 'status@broadcast') return;

  // Normaliza mensagens efêmeras / temporárias ou view-once
  const msg = {
    ...rawMsg,
    message: normalizeMessage(rawMsg.message),
  };

  const remoteJid = msg.key.remoteJid;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = msg.key.participant || msg.participant || remoteJid;
  const isFromMe = msg.key.fromMe;
  const botInfo = getBotIdentifiers(sock);

  // Registra mensagens que o próprio bot enviou para detecção de replies futuros
  if (isFromMe) {
    if (msg.key?.id) {
      rememberBotSentMessage(msg.key.id);
    }
    return;
  }

  const text = extractMessageText(msg);
  const hasDirectMedia = !!(
    msg.message?.imageMessage ||
    msg.message?.videoMessage ||
    msg.message?.stickerMessage
  );
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.stickerMessage?.contextInfo ||
    msg.message?.audioMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo;
  const hasQuotedMedia = !!(
    contextInfo?.quotedMessage?.imageMessage ||
    contextInfo?.quotedMessage?.videoMessage ||
    contextInfo?.quotedMessage?.stickerMessage
  );

  // Se não tem texto, nem mídia direta, nem mídia citada, nem citação de mensagem, ignora
  if (!text && !hasDirectMedia && !hasQuotedMedia && !contextInfo?.quotedMessage) return;

  // Carrega informações do grupo se for mensagem de grupo
  let groupMetadata = null;
  let isSenderAdmin = false;
  let isBotAdmin = false;

  if (isGroup) {
    try {
      groupMetadata = await sock.groupMetadata(remoteJid);
      if (groupMetadata && groupMetadata.participants) {
        isSenderAdmin = isParticipantAdmin(groupMetadata.participants, senderJid, sock);
        isBotAdmin = isParticipantAdmin(groupMetadata.participants, botInfo.phoneJid || botInfo.lidJid, sock);
      }
    } catch (err) {
      // Ignora erro de metadados se não for possível consultar no momento
    }
  }

  // ==========================================
  // 🛡️ MODERAÇÃO: ANTI-LINK NO GRUPO
  // ==========================================
  if (isGroup && !isFromMe && groupState.isAntiLinkEnabled(remoteJid) && text) {
    const hasLink = LINK_REGEX.test(text);

    if (hasLink && !isSenderAdmin) {
      console.log(`🚨 Link detectado enviado por não-admin (${senderJid}) no grupo ${remoteJid}`);

      // Tenta apagar a mensagem se o bot for administrador
      if (isBotAdmin) {
        try {
          await sock.sendMessage(remoteJid, { delete: msg.key });
        } catch (delError) {
          console.error('Falha ao apagar mensagem de link proibido:', delError?.message);
        }

        const senderTag = `@${senderJid.split('@')[0]}`;
        await sendBotMessage(sock, remoteJid, {
          text: `⚠️ ${senderTag} *Links não são permitidos neste grupo!*\nSua mensagem foi apagada pela moderação.`,
          mentions: [senderJid],
        });
      } else {
        // Alerta sem apagar (caso o bot não tenha permissão de admin)
        const senderTag = `@${senderJid.split('@')[0]}`;
        await sendBotMessage(sock, remoteJid, {
          text: `⚠️ ${senderTag} *Atenção:* Links são proibidos neste grupo!\n\n_💡 Dica: Torne o bot administrador para que ele consiga apagar as mensagens proibidas automaticamente._`,
          mentions: [senderJid],
        });
      }

      // Interrompe o processamento para não executar comandos dentro do link
      return;
    }
  }

  // ==========================================
  // 🎯 DETECÇÃO DE MENÇÕES E CITAÇÕES (REPLY / QUOTE)
  // ==========================================
  const mentionedJids = contextInfo?.mentionedJid || [];
  const isBotMentioned = mentionedJids.some((j) => isBotJid(j, sock));

  // Verifica se o usuário anexou / citou uma mensagem enviada pelo bot:
  // 1. O ID da mensagem citada está na lista de mensagens enviadas pelo bot nesta sessão
  // 2. O participante da mensagem citada é o próprio bot (por número de telefone ou LID)
  // 3. Em conversa privada (DM), qualquer citação é direcionada ao bot
  const isQuotingBotMessageId = Boolean(contextInfo?.stanzaId && botSentMessageIds.has(contextInfo.stanzaId));
  const isQuotingBotParticipant = Boolean(contextInfo?.participant && isBotJid(contextInfo.participant, sock));
  const isQuotingInPrivateChat = Boolean(
    !isGroup &&
    contextInfo?.quotedMessage &&
    (!contextInfo.participant || isBotJid(contextInfo.participant, sock))
  );

  const isReplyingToBot = isQuotingBotMessageId || isQuotingBotParticipant || isQuotingInPrivateChat;

  // ==========================================
  // 🤖 RESPOSTA COM INTELIGÊNCIA ARTIFICIAL (GEMINI)
  // ==========================================
  const prefix = config.botPrefix;
  const isAiCommand =
    text.startsWith(`${prefix}ia `) ||
    text.startsWith(`${prefix}ai `) ||
    text.toLowerCase() === `${prefix}ia` ||
    text.toLowerCase() === `${prefix}ai`;
  const isPrivateChat = !isGroup && (!text || !text.startsWith(prefix));

  // Palavras-chave que chamam o bot no grupo mesmo sem @
  const lowerText = text.toLowerCase();
  const triggerKeywords = [
    'saimon',
    'zapbot',
    'bot',
    'robô',
    'robo',
    'joão marcelo',
    'joao marcelo',
  ];
  const containsTriggerKeyword = isGroup && triggerKeywords.some((kw) => lowerText.includes(kw));

  // Modo "intrometido" com chance aleatória em mensagens comuns de grupo
  const isRandomIntervention =
    isGroup &&
    text &&
    !text.startsWith(prefix) &&
    !isBotMentioned &&
    !isReplyingToBot &&
    !containsTriggerKeyword &&
    text.length >= 4 &&
    Math.random() < config.groupRandomReplyChance;

  const shouldTriggerAi =
    isAiCommand ||
    isPrivateChat ||
    (isGroup && (isBotMentioned || isReplyingToBot || containsTriggerKeyword || isRandomIntervention));

  if (shouldTriggerAi) {
    let question = text;
    const quotedSummary = getQuotedMessageSummary(contextInfo?.quotedMessage);

    if (isAiCommand) {
      question = text.replace(new RegExp(`^${prefix}(ia|ai)(\\s+|$)`, 'i'), '').trim();
    } else if (isBotMentioned || isReplyingToBot) {
      // Remove menções de marcação do texto
      question = text.replace(/@\d+/g, '').trim();
    }

    // Baixa mídia se houver (imagem ou vídeo direto ou citado)
    let media = null;
    if (hasDirectMedia || hasQuotedMedia) {
      media = await extractMedia(sock, msg);
    }

    if (media?.buffer && media.buffer.length > 20 * 1024 * 1024) {
      await sendBotMessage(
        sock,
        remoteJid,
        { text: '⚠️ Esse vídeo é muito grande (acima de 20MB) para eu analisar diretamente aqui no WhatsApp.' },
        { quoted: msg }
      );
      return;
    }

    // Formata o contexto quando houver citação de mensagem (reply / quote)
    if (isReplyingToBot) {
      if (quotedSummary) {
        if (question) {
          question = `[Respondendo à sua mensagem anterior onde você disse: "${quotedSummary}"]\n${question}`;
        } else if (media?.type === 'sticker') {
          question = `[O usuário respondeu à sua mensagem anterior "${quotedSummary}" enviando esta figurinha (sticker)]. Reaja com sua personalidade e deboche de pato!`;
        } else if (media?.type === 'image') {
          question = `[O usuário respondeu à sua mensagem anterior "${quotedSummary}" enviando esta foto/imagem]. O que achou?`;
        } else if (media?.type === 'video') {
          question = `[O usuário respondeu à sua mensagem anterior "${quotedSummary}" enviando este vídeo]. O que achou?`;
        } else {
          question = `[O usuário citou e respondeu à sua mensagem anterior: "${quotedSummary}"]`;
        }
      }
    } else if (quotedSummary) {
      if (question) {
        question = `[Citando a mensagem de outro participante: "${quotedSummary}"]\n${question}`;
      } else if (media) {
        question = `[Citando a mensagem de outro participante: "${quotedSummary}" com mídia anexa] O que você acha?`;
      } else {
        question = `[Citando a mensagem de outro participante: "${quotedSummary}"] O que você acha disso?`;
      }
    }

    if (!question) {
      if (media) {
        if (media.type === 'video') {
          question = 'O que você achou desse vídeo?';
        } else if (media.type === 'sticker') {
          question = 'O usuário enviou esta figurinha (sticker). Diga o que você achou da figurinha ou do meme/cara dela com sua personalidade e deboche de pato!';
        } else {
          question = 'O que você achou dessa foto/imagem?';
        }
      } else {
        question = 'Opa, me chamou por quê? O que manda?';
      }
    }

    if (isReplyingToBot) {
      console.log(`💬 Resposta a citação direta de ${config.botName} por ${senderJid}: "${question.replace(/\n/g, ' ')}"`);
    } else if (isRandomIntervention) {
      console.log(`🎲 Intervenção aleatória de ${config.botName} ativada no grupo para ${senderJid}: "${question}"`);
    } else if (containsTriggerKeyword) {
      console.log(`🎯 Palavra-chave detectada na mensagem de ${senderJid}: "${question}"`);
    } else if (media) {
      console.log(`📸 Processando ${media.type} com IA para ${senderJid}: "${question}"`);
    } else {
      console.log(`🤖 Processando pergunta de IA para ${senderJid}: "${question}"`);
    }

    // Ativa o status visual de 'digitando...' no WhatsApp
    try {
      await sock.sendPresenceUpdate('composing', remoteJid);
    } catch {}

    const aiResponse = await askGemini(question, {
      userName: msg.pushName || senderJid.split('@')[0],
      isGroup: isGroup,
      groupName: isGroup ? (groupMetadata?.subject || 'Grupo') : '',
      media,
      chatId: remoteJid,
    });

    try {
      await sendBotMessage(
        sock,
        remoteJid,
        {
          text: aiResponse,
        },
        { quoted: msg }
      );
    } catch (sendErr) {
      console.warn(`⚠️ Envio com citação falhou, enviando direto: ${sendErr?.message}`);
      await sendBotMessage(sock, remoteJid, {
        text: aiResponse,
      });
    }

    return;
  }

  // ==========================================
  // ⌨️ COMANDOS DO BOT (INICIADOS COM PREFIXO)
  // ==========================================
  if (!text.startsWith(prefix)) return;

  const args = text.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  switch (command) {
    case 'menu':
    case 'ajuda':
    case 'help': {
      const menuText = `🤖 *MENU DO ${config.botName.toUpperCase()}*

📌 *Comandos de Inteligência Artificial:*
• *${prefix}ia <pergunta>*: Faça qualquer pergunta para a IA do bot.
• *Fotos e Vídeos*: Envie ou cite uma foto/vídeo com *${prefix}ia* ou marcando *@${config.botName}* para ele analisar!
• *${prefix}reset* ou *${prefix}limpar*: Limpa a memória recente da conversa para iniciar um novo assunto.
• _Você também pode apenas me marcar (@${config.botName}) ou responder/anexar uma mensagem minha!_

🛡️ *Moderação de Grupo:*
• *${prefix}regras*: Exibe as regras oficiais do grupo.
• *${prefix}antilink on/off*: Ativa ou desativa bloqueio de links (Admins).
• *${prefix}aviso <texto>*: Envia um comunicado marcando todos (Admins).

⚙️ *Utilitários & Status:*
• *${prefix}ping*: Testa a conexão e tempo de resposta do bot.
• *${prefix}status*: Mostra o status do bot e permissões no grupo.

_Dúvidas ou sugestões? Converse com os administradores._`;

      await sendBotMessage(sock, remoteJid, { text: menuText }, { quoted: msg });
      break;
    }

    case 'regras': {
      await sendBotMessage(
        sock,
        remoteJid,
        {
          text: config.groupRules,
        },
        { quoted: msg }
      );
      break;
    }

    case 'ping': {
      const start = Date.now();
      await sendBotMessage(
        sock,
        remoteJid,
        {
          text: `🏓 *Pong!*\n⏱️ Tempo de resposta: _${Date.now() - start}ms_\n🤖 Status: *Online e Operacional*`,
        },
        { quoted: msg }
      );
      break;
    }

    case 'reset':
    case 'limpar':
    case 'esquecer': {
      clearChatMemory(remoteJid);
      await sendBotMessage(
        sock,
        remoteJid,
        {
          text: `🧠 *Memória resetada!* Esqueci as mensagens recentes dessa conversa. Pode iniciar um novo assunto do zero!`,
        },
        { quoted: msg }
      );
      break;
    }

    case 'status': {
      const antiLinkActive = groupState.isAntiLinkEnabled(remoteJid);
      const statusText = `📊 *STATUS DO SISTEMA:*

• *Nome do Bot:* ${config.botName}
• *Tipo:* ${isGroup ? 'Grupo WhatsApp' : 'Chat Privado'}
• *Anti-Link Ativo:* ${antiLinkActive ? '✅ Sim' : '❌ Não'}
• *Bot é Administrador:* ${isBotAdmin ? '✅ Sim (Moderação completa ativa)' : '⚠️ Não (Recomendado tornar admin)'}
• *Modelo de IA:* \`${config.geminiModel}\`
• *Chave Gemini:* ${config.geminiApiKey ? '✅ Configurada' : '❌ Ausente no .env'}`;

      await sendBotMessage(sock, remoteJid, { text: statusText }, { quoted: msg });
      break;
    }

    case 'antilink': {
      if (!isGroup) {
        await sendBotMessage(sock, remoteJid, { text: '❌ Este comando só pode ser utilizado em grupos.' }, { quoted: msg });
        return;
      }

      if (!isSenderAdmin) {
        await sendBotMessage(sock, remoteJid, { text: '⛔ Apenas administradores do grupo podem alterar o Anti-Link.' }, { quoted: msg });
        return;
      }

      const option = args[0]?.toLowerCase();
      if (option === 'on' || option === 'ativar') {
        groupState.setAntiLink(remoteJid, true);
        await sendBotMessage(sock, remoteJid, { text: '🛡️ *Anti-Link ativado!* Mensagens com links enviados por participantes comuns serão deletadas.' }, { quoted: msg });
      } else if (option === 'off' || option === 'desativar') {
        groupState.setAntiLink(remoteJid, false);
        await sendBotMessage(sock, remoteJid, { text: '🔓 *Anti-Link desativado!* Links estão liberados temporariamente.' }, { quoted: msg });
      } else {
        const current = groupState.isAntiLinkEnabled(remoteJid);
        await sendBotMessage(sock, remoteJid, { text: `ℹ️ O Anti-Link está atualmente: *${current ? 'ATIVADO' : 'DESATIVADO'}*.\nUse *${prefix}antilink on* ou *${prefix}antilink off*.` }, { quoted: msg });
      }
      break;
    }

    case 'aviso': {
      if (!isGroup) {
        await sendBotMessage(sock, remoteJid, { text: '❌ Este comando só pode ser utilizado em grupos.' }, { quoted: msg });
        return;
      }

      if (!isSenderAdmin) {
        await sendBotMessage(sock, remoteJid, { text: '⛔ Apenas administradores do grupo podem enviar comunicados globais.' }, { quoted: msg });
        return;
      }

      const noticeText = args.join(' ');
      if (!noticeText) {
        await sendBotMessage(sock, remoteJid, { text: `⚠️ Digite a mensagem do comunicado. Exemplo: *${prefix}aviso Reunião hoje às 20h!*` }, { quoted: msg });
        return;
      }

      const participants = groupMetadata?.participants?.map((p) => p.id) || [];
      const senderTag = `@${senderJid.split('@')[0]}`;

      const broadcastMessage = `📢 *COMUNICADO OFICIAL DO GRUPO:*\n\n${noticeText}\n\n_Enviado pelo admin ${senderTag}_`;

      await sendBotMessage(sock, remoteJid, {
        text: broadcastMessage,
        mentions: participants,
      });
      break;
    }

    default: {
      // Não responde a comandos desconhecidos em grupos para evitar ruído
      if (!isGroup) {
        await sendBotMessage(
          sock,
          remoteJid,
          {
            text: `❓ Comando não reconhecido. Digite *${prefix}menu* para ver a lista de comandos disponíveis.`,
          },
          { quoted: msg }
        );
      }
      break;
    }
  }
}
