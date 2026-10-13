import cron from 'node-cron';
import { config } from '../config.js';

let activeCronJobs = [];

/**
 * Inicializa os agendamentos de tarefas e notificações para o WhatsApp.
 * @param {object} sock Instância do socket Baileys
 */
export function initScheduler(sock) {
  // Limpa agendamentos anteriores em caso de reconexão
  stopScheduler();

  if (!config.scheduleEnabled) {
    console.log('⏰ Notificações agendadas estão desativadas no .env (SCHEDULE_ENABLED=false).');
    return;
  }

  if (!cron.validate(config.scheduleCron)) {
    console.error(`❌ Expressão cron inválida configurada: "${config.scheduleCron}"`);
    return;
  }

  console.log(`⏰ Agendador ativado com padrão cron: "${config.scheduleCron}"`);

  const job = cron.schedule(config.scheduleCron, async () => {
    try {
      console.log('⏰ Disparando notificação agendada...');

      if (config.scheduleTargetGroup) {
        // Envia para o grupo específico configurado
        const targetJid = config.scheduleTargetGroup.includes('@g.us')
          ? config.scheduleTargetGroup
          : `${config.scheduleTargetGroup}@g.us`;

        await sock.sendMessage(targetJid, { text: config.scheduleMessage });
        console.log(`✅ Notificação agendada enviada com sucesso para ${targetJid}`);
      } else {
        // Se nenhum grupo específico for definido, busca todos os grupos participantes
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);

        console.log(`📢 Enviando notificação agendada para ${groupIds.length} grupos participantes...`);
        for (const jid of groupIds) {
          try {
            await sock.sendMessage(jid, { text: config.scheduleMessage });
          } catch (err) {
            console.error(`Falha ao enviar notificação agendada para ${jid}:`, err?.message);
          }
        }
      }
    } catch (error) {
      console.error('❌ Erro ao executar tarefa agendada:', error);
    }
  });

  activeCronJobs.push(job);
}

/**
 * Para todos os jobs agendados ativos
 */
export function stopScheduler() {
  for (const job of activeCronJobs) {
    job.stop();
  }
  activeCronJobs = [];
}
