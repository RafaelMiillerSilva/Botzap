# 🤖 Botzap - Bot de WhatsApp para Grupos

Bot completo e modular para grupos de WhatsApp desenvolvido em **Node.js** utilizando a biblioteca **Baileys** (@whiskeysockets/baileys) e integração com a Inteligência Artificial **Google Gemini** (`gemini-3.8-flash`).

---

## 🚀 Funcionalidades

1. **🛡️ Moderação de Grupo & Anti-Link**:
   - Detecta links externos, grupos e links suspeitos enviados por membros comuns.
   - Apaga automaticamente a mensagem proibida caso o bot seja administrador do grupo.
   - Marca o infrator com aviso educativo.
   - Ativação/Desativação dinâmica no grupo com comando `!antilink on` e `!antilink off` (exclusivo para admins).

2. **🤖 Inteligência Artificial (Google Gemini)**:
   - Respostas inteligentes e contextuais dentro do grupo.
   - Acionado via comando `!ia <pergunta>` ou simplesmente marcando o bot no grupo (`@ZapBot <dúvida>`).
   - Respostas concisas, amigáveis e formatadas para o WhatsApp.

3. **👋 Boas-vindas Automáticas**:
   - Mensagem calorosa personalizada marcando novos participantes ao entrarem no grupo.
   - Orientação inicial para leitura de regras (`!regras`) e comandos (`!menu`).

4. **⏰ Avisos e Notificações Agendadas**:
   - Agendador integrado com `node-cron`.
   - Disparo automático de comunicados matinais ou lembretes programados.

5. **📢 Comunicado para Todos os Membros**:
   - Comando `!aviso <texto>` para administradores mencionarem todos os membros de uma só vez com um anúncio destacado.

---

## 🛠️ Pré-requisitos

- **Node.js** v20+ instalado (Já instalado).
- Um número de WhatsApp para o bot (recomenda-se utilizar um chip secundário dedicado para automações).
- Chave gratuita da API do **Google Gemini**: [Obter chave no Google AI Studio](https://aistudio.google.com/).

---

## ⚙️ Configuração Passo a Passo

### 1. Configurar o arquivo `.env`

Abra o arquivo `.env` na raiz do projeto e configure suas variáveis:

```env
# Nome do Bot e Prefixo de comando
BOT_NAME="ZapBot"
BOT_PREFIX="!"

# Chave da API Gemini (Obtenha em https://aistudio.google.com/)
GEMINI_API_KEY="COLOQUE_SUA_CHAVE_AQUI"
GEMINI_MODEL="gemini-3.8-flash"

# Moderação de Grupo
ANTI_LINK=true

# Boas-vindas
WELCOME_ENABLED=true

# Notificações Agendadas (Opcional - deixe false se não quiser)
SCHEDULE_ENABLED=false
SCHEDULE_CRON="0 9 * * *"
```

---

## 📱 Como Conectar e Rodar o Bot

### Passo 1: Iniciar o Bot

No terminal, dentro da pasta do projeto (`Botzap`), execute:

```bash
npm start
```

### Passo 2: Escanear o QR Code

1. No terminal será exibido um **QR Code**.
2. Abra o WhatsApp no seu smartphone com o número do bot.
3. Toque nos 3 pontos (ou Configurações no iPhone) > **Aparelhos Conectados** > **Conectar um aparelho**.
4. Aponte a câmera para o QR Code no terminal.
5. Em poucos segundos o terminal confirmará: `🎉 ZapBot CONECTADO COM SUCESSO!`.

> **Nota:** As credenciais de conexão são salvas na pasta `auth_info/`. Uma vez autenticado, você não precisará ler o QR Code toda vez que iniciar o bot.

### Passo 3: Colocar o Bot no Grupo

1. No seu WhatsApp, crie um grupo ou abra um grupo existente.
2. Adicione o número do bot como participante do grupo.
3. **Importante:** Promova o bot a **Administrador do grupo**. Isso é necessário para que o bot tenha permissão de:
   - Apagar mensagens com links não autorizados (Anti-Link).
   - Identificar novos membros e aplicar moderação completa.

---

## 📋 Lista de Comandos

| Comando | Descrição | Quem pode usar |
| --- | --- | --- |
| `!menu` ou `!ajuda` | Mostra todos os comandos disponíveis | Todos |
| `!ia <pergunta>` | Envia uma pergunta para a IA do Gemini responder no grupo | Todos |
| `!ia` (com foto/vídeo) | Envia ou cita uma imagem/vídeo para a IA analisar | Todos |
| `@ZapBot <pergunta>` | Marcando o bot diretamente no grupo, ele responderá com IA | Todos |
| `!regras` | Mostra as regras e condutas do grupo | Todos |
| `!ping` | Testa se o bot está ativo e mostra a latência | Todos |
| `!status` | Exibe o status do bot e se ele é admin do grupo | Todos |
| `!antilink on` | Ativa a remoção de links não autorizados | Apenas Admins |
| `!antilink off` | Desativa temporariamente a remoção de links | Apenas Admins |
| `!aviso <mensagem>` | Envia um comunicado oficial mencionando todos os membros | Apenas Admins |

---

## 📁 Estrutura de Arquivos

```text
Botzap/
├── auth_info/             # Credenciais da sessão do WhatsApp (gerado automaticamente)
├── src/
│   ├── config.js          # Configurações globais e estado dinâmico dos grupos
│   ├── index.js           # Ponto de entrada e conexão Baileys
│   ├── handlers/
│   │   ├── groupHandler.js    # Tratamento de entrada/saída de membros (boas-vindas)
│   │   └── messageHandler.js  # Comandos, moderação anti-link e respostas de IA
│   └── services/
│       ├── geminiService.js   # Integração com o Google Gemini (@google/genai)
│       └── scheduler.js       # Agendador de tarefas e notificações (node-cron)
├── .env                   # Variáveis de ambiente e credenciais
├── .env.example           # Modelo de exemplo do arquivo .env
├── package.json           # Dependências e scripts npm
└── README.md              # Guia completo de uso
```
