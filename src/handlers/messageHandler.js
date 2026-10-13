import { config, groupState } from '../config.js';
import { askGemini } from '../services/geminiService.js';

// Regex para identificar links de sites, grupos e WhatsApp
const LINK_REGEX = /((https?:\/\/)|(www\.)|(chat\.whatsapp\.com\/)|(wa\.me\/))[^\s]+/gi;

/**
 * Extrai o texto limpo da mensagem do Baileys
 */
function extractMessageText(msg) {
  const m = msg.message;
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
 * Normaliza o JID removendo sufixo de dispositivo (ex: 551199999999:1@s.whatsapp.net -> 551199999999@s.whatsapp.net)
 */
function cleanJid(jid) {
  if (!jid) return '';
  return jid.split(':')[0].replace(/@.*/, '') + '@s.whatsapp.net';
}

/**
 * Verifica se um participante é administrador no grupo
 */
function isParticipantAdmin(participants, participantJid) {
  const pId = cleanJid(participantJid);
  const found = participants.find((p) => cleanJid(p.id) === pId);
  return found ? found.admin === 'admin' || found.admin === 'superadmin' : false;
}

/**
 * Trata as mensagens recebidas via WhatsApp
 * @param {object} sock Instância do socket Baileys
 * @param {object} m Objeto do evento messages.upsert
 */
export async function handleIncomingMessages(sock, m) {
  const msg = m.messages?.[0];
  if (!msg || !msg.message) return;

  // Ignora mensagens de status/stories
  if (msg.key.remoteJid === 'status@broadcast') return;

  const remoteJid = msg.key.remoteJid;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = msg.key.participant || msg.participant || remoteJid;
  const isFromMe = msg.key.fromMe;
  const botJid = sock.user?.id ? cleanJid(sock.user.id) : '';

  const text = extractMessageText(msg);
  if (!text) return;

  // Carrega informações do grupo se for mensagem de grupo
  let groupMetadata = null;
  let isSenderAdmin = false;
  let isBotAdmin = false;

  if (isGroup) {
    try {
      groupMetadata = await sock.groupMetadata(remoteJid);
      if (groupMetadata && groupMetadata.participants) {
        isSenderAdmin = isParticipantAdmin(groupMetadata.participants, senderJid);
        isBotAdmin = isParticipantAdmin(groupMetadata.participants, botJid);
      }
    } catch (err) {
      // Ignora erro de metadados se não for possível consultar no momento
    }
  }

  // ==========================================
  // 🛡️ MODERAÇÃO: ANTI-LINK NO GRUPO
  // ==========================================
  if (isGroup && !isFromMe && groupState.isAntiLinkEnabled(remoteJid)) {
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
        await sock.sendMessage(remoteJid, {
          text: `⚠️ ${senderTag} *Links não são permitidos neste grupo!*\nSua mensagem foi apagada pela moderação.`,
          mentions: [senderJid],
        });
      } else {
        // Alerta sem apagar (caso o bot não tenha permissão de admin)
        const senderTag = `@${senderJid.split('@')[0]}`;
        await sock.sendMessage(remoteJid, {
          text: `⚠️ ${senderTag} *Atenção:* Links são proibidos neste grupo!\n\n_💡 Dica: Torne o bot administrador para que ele consiga apagar as mensagens proibidas automaticamente._`,
          mentions: [senderJid],
        });
      }

      // Interrompe o processamento para não executar comandos dentro do link
      return;
    }
  }

  // Não processa comandos emitidos pelo próprio bot
  if (isFromMe) return;

  // Verifica menção direta ao bot
  const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const isBotMentioned = mentionedJids.some((j) => cleanJid(j) === botJid);

  // ==========================================
  // 🤖 RESPOSTA COM INTELIGÊNCIA ARTIFICIAL (GEMINI)
  // ==========================================
  const prefix = config.botPrefix;
  const isAiCommand = text.startsWith(`${prefix}ia `) || text.startsWith(`${prefix}ai `);

  if (isAiCommand || (isGroup && isBotMentioned)) {
    let question = text;

    if (isAiCommand) {
      question = text.replace(new RegExp(`^${prefix}(ia|ai)\\s+`, 'i'), '').trim();
    } else if (isBotMentioned) {
      // Remove menções de marcação do texto
      question = text.replace(/@\d+/g, '').trim();
    }

    if (!question) {
      await sock.sendMessage(
        remoteJid,
        {
          text: `💡 Olá! Para falar com a Inteligência Artificial, digite *${prefix}ia sua pergunta* ou me marque com sua dúvida!`,
        },
        { quoted: msg }
      );
      return;
    }

    console.log(`🤖 Processando pergunta de IA para ${senderJid}: "${question}"`);

    // Indicador visual de resposta (reação de "pensando")
    try {
      await sock.sendMessage(remoteJid, {
        react: { text: '⏳', key: msg.key },
      });
    } catch {}

    const aiResponse = await askGemini(question, {
      userName: msg.pushName || senderJid.split('@')[0],
      groupName: groupMetadata?.subject || 'Grupo',
    });

    await sock.sendMessage(
      remoteJid,
      {
        text: `🤖 *${config.botName} (IA):*\n\n${aiResponse}`,
      },
      { quoted: msg }
    );

    // Reação de concluído
    try {
      await sock.sendMessage(remoteJid, {
        react: { text: '✅', key: msg.key },
      });
    } catch {}

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
• _Você também pode apenas me marcar (@${config.botName}) com sua dúvida!_

🛡️ *Moderação de Grupo:*
• *${prefix}regras*: Exibe as regras oficiais do grupo.
• *${prefix}antilink on/off*: Ativa ou desativa bloqueio de links (Admins).
• *${prefix}aviso <texto>*: Envia um comunicado marcando todos (Admins).

⚙️ *Utilitários & Status:*
• *${prefix}ping*: Testa a conexão e tempo de resposta do bot.
• *${prefix}status*: Mostra o status do bot e permissões no grupo.

_Dúvidas ou sugestões? Converse com os administradores._`;

      await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
      break;
    }

    case 'regras': {
      await sock.sendMessage(
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
      await sock.sendMessage(
        remoteJid,
        {
          text: `🏓 *Pong!*\n⏱️ Tempo de resposta: _${Date.now() - start}ms_\n🤖 Status: *Online e Operacional*`,
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

      await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg });
      break;
    }

    case 'antilink': {
      if (!isGroup) {
        await sock.sendMessage(remoteJid, { text: '❌ Este comando só pode ser utilizado em grupos.' }, { quoted: msg });
        return;
      }

      if (!isSenderAdmin) {
        await sock.sendMessage(remoteJid, { text: '⛔ Apenas administradores do grupo podem alterar o Anti-Link.' }, { quoted: msg });
        return;
      }

      const option = args[0]?.toLowerCase();
      if (option === 'on' || option === 'ativar') {
        groupState.setAntiLink(remoteJid, true);
        await sock.sendMessage(remoteJid, { text: '🛡️ *Anti-Link ativado!* Mensagens com links enviados por participantes comuns serão deletadas.' }, { quoted: msg });
      } else if (option === 'off' || option === 'desativar') {
        groupState.setAntiLink(remoteJid, false);
        await sock.sendMessage(remoteJid, { text: '🔓 *Anti-Link desativado!* Links estão liberados temporariamente.' }, { quoted: msg });
      } else {
        const current = groupState.isAntiLinkEnabled(remoteJid);
        await sock.sendMessage(remoteJid, { text: `ℹ️ O Anti-Link está atualmente: *${current ? 'ATIVADO' : 'DESATIVADO'}*.\nUse *${prefix}antilink on* ou *${prefix}antilink off*.` }, { quoted: msg });
      }
      break;
    }

    case 'aviso': {
      if (!isGroup) {
        await sock.sendMessage(remoteJid, { text: '❌ Este comando só pode ser utilizado em grupos.' }, { quoted: msg });
        return;
      }

      if (!isSenderAdmin) {
        await sock.sendMessage(remoteJid, { text: '⛔ Apenas administradores do grupo podem enviar comunicados globais.' }, { quoted: msg });
        return;
      }

      const noticeText = args.join(' ');
      if (!noticeText) {
        await sock.sendMessage(remoteJid, { text: `⚠️ Digite a mensagem do comunicado. Exemplo: *${prefix}aviso Reunião hoje às 20h!*` }, { quoted: msg });
        return;
      }

      const participants = groupMetadata?.participants?.map((p) => p.id) || [];
      const senderTag = `@${senderJid.split('@')[0]}`;

      const broadcastMessage = `📢 *COMUNICADO OFICIAL DO GRUPO:*\n\n${noticeText}\n\n_Enviado pelo admin ${senderTag}_`;

      await sock.sendMessage(remoteJid, {
        text: broadcastMessage,
        mentions: participants,
      });
      break;
    }

    default: {
      // Não responde a comandos desconhecidos em grupos para evitar ruído
      if (!isGroup) {
        await sock.sendMessage(
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
