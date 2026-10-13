import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { handleIncomingMessages } from './handlers/messageHandler.js';
import { handleGroupParticipantsUpdate } from './handlers/groupHandler.js';
import { initScheduler, stopScheduler } from './services/scheduler.js';
import { config } from './config.js';

let isRestarting = false;

async function startBot() {
  console.log(`\n🚀 Iniciando ${config.botName}...`);

  // Carrega ou inicializa a sessão salva em pasta local
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`📦 Usando Baileys v${version.join('.')} (Última versão: ${isLatest ? 'Sim' : 'Não'})`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // Log limpo no terminal
    printQRInTerminal: false,
    browser: [config.botName, 'Desktop', '1.0.0'],
    generateHighQualityLinkPreview: true,
  });

  // Atualizações de credenciais da sessão
  sock.ev.on('creds.update', saveCreds);

  // Monitora o status da conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Se houver um QR Code a ser lido
    if (qr) {
      console.log('\n============================================================');
      console.log(' 📲 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP');
      console.log(' 1. Abra o WhatsApp no seu smartphone');
      console.log(' 2. Vá em Configurações > Dispositivos Conectados > Conectar');
      console.log(' 3. Aponte a câmera para o QR Code abaixo:');
      console.log('============================================================\n');
      qrcode.generate(qr, { small: true });
    }

    // Conexão aberta com sucesso
    if (connection === 'open') {
      isRestarting = false;
      const userPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';

      console.log('\n============================================================');
      console.log(` 🎉 ${config.botName} CONECTADO COM SUCESSO!`);
      console.log(` 📱 Número conectado: +${userPhone}`);
      console.log(` 🛡️ Anti-Link padrão: ${config.antiLink ? 'ATIVADO' : 'DESATIVADO'}`);
      console.log(` 🤖 Modelo IA: ${config.geminiModel}`);
      console.log('============================================================\n');

      // Inicializa tarefas de notificação agendada
      initScheduler(sock);
    }

    // Conexão encerrada
    if (connection === 'close') {
      stopScheduler();

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `⚠️ Conexão encerrada. Motivo: ${lastDisconnect?.error?.message || statusCode || 'Desconhecido'}`
      );

      if (shouldReconnect) {
        if (!isRestarting) {
          isRestarting = true;
          console.log('🔄 Tentando reconectar em 5 segundos...');
          setTimeout(() => {
            isRestarting = false;
            startBot();
          }, 5000);
        }
      } else {
        console.log(
          '❌ Sessão desconectada ou desconectada pelo aparelho. Remova a pasta "auth_info" se quiser gerar um novo QR Code e reinicie.'
        );
      }
    }
  });

  // Evento de novas mensagens recebidas
  sock.ev.on('messages.upsert', async (m) => {
    try {
      await handleIncomingMessages(sock, m);
    } catch (err) {
      console.error('❌ Erro no tratamento da mensagem:', err);
    }
  });

  // Evento de novos membros / saídas de grupos
  sock.ev.on('group-participants.update', async (update) => {
    try {
      await handleGroupParticipantsUpdate(sock, update);
    } catch (err) {
      console.error('❌ Erro no tratamento de membros do grupo:', err);
    }
  });
}

// Inicia o bot
startBot().catch((err) => {
  console.error('❌ Erro fatal ao iniciar o bot:', err);
});
