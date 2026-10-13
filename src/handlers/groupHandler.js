import { config } from '../config.js';

/**
 * Trata eventos de entrada, saída ou alterações de membros no grupo.
 * @param {object} sock Instância do socket Baileys
 * @param {object} update Objeto do evento group-participants.update
 */
export async function handleGroupParticipantsUpdate(sock, update) {
  const { id: groupId, participants, action } = update;

  if (!groupId || !participants || !participants.length) return;

  try {
    let groupMetadata = null;
    try {
      groupMetadata = await sock.groupMetadata(groupId);
    } catch {
      groupMetadata = { subject: 'Grupo' };
    }

    const groupName = groupMetadata?.subject || 'Grupo';

    // Ação: Novo membro entrou ou foi adicionado
    if (action === 'add' && config.welcomeEnabled) {
      for (const participant of participants) {
        const userTag = `@${participant.split('@')[0]}`;
        const welcomeText = config.welcomeMessage
          .replace(/@user/g, userTag)
          .replace(/{group_name}/g, groupName);

        await sock.sendMessage(groupId, {
          text: welcomeText,
          mentions: [participant],
        });

        console.log(`🎉 Boas-vindas enviadas para ${participant} no grupo "${groupName}"`);
      }
    }

    // Ação: Membro saiu ou foi removido
    if (action === 'remove') {
      for (const participant of participants) {
        const userTag = `@${participant.split('@')[0]}`;
        console.log(`👋 Participante ${userTag} saiu do grupo "${groupName}"`);
      }
    }

    // Ação: Membro promovido a admin
    if (action === 'promote') {
      for (const participant of participants) {
        console.log(`⭐ Participante ${participant} promovido a administrador em "${groupName}"`);
      }
    }
  } catch (error) {
    console.error('❌ Erro ao processar atualização de participantes do grupo:', error);
  }
}
