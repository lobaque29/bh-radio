# BH Rádio — piloto

Rádio PTT por região para motoboys de BH. Voz via **LiveKit** (WebRTC + Opus 24 kbps com DTX), controle de palavra, alertas (blitz, chuva, acidente) e **localização da blitz ao vivo** para quem está no canal.

## O que já funciona
- Cadastro rápido (nome + WhatsApp + código do piloto + consentimento)
- 5 canais (CH 0 geral, CH 1–4 regiões); quem está no CH 0 recebe alertas de todos os canais
- Um fala por vez (o servidor decide quem tem a palavra; máximo 45 s por fala)
- Alertas com som e vibração; blitz com GPS ao vivo por 5 min, distância até você e botão "Já saiu" (2 confirmações removem)
- Denúncia de quem está falando e banimento por WhatsApp (rotas /admin)
- PWA instalável (Adicionar à tela inicial)

## O que NÃO funciona ainda (limites do piloto em navegador)
- **Sem áudio com a tela apagada.** O app precisa ficar aberto e com a tela ligada (ele pede "wake lock"). Rodar em segundo plano exige o app nativo (fase seguinte).
- **PTT só por toque** (ou barra de espaço no PC). Botão de volume e fone Bluetooth só no app nativo. Por isso, no piloto, use **só com a moto parada ou com o celular no suporte sem mexer na tela em movimento**. O "Modo toque" (liga/desliga) ajuda a reduzir o esforço.
- Estado em memória: reiniciar o servidor apaga alertas e sessões (as pessoas só reentram).
- Uma única instância do servidor (suficiente para dezenas de pessoas).
- Sem pagamento. Pix entra depois do piloto.

## 1. Conta no LiveKit (grátis para testar)
1. Crie conta em https://cloud.livekit.io e um projeto.
2. Em **Settings → Keys**, crie uma chave. Anote **URL (wss://...)**, **API Key** e **API Secret**.

## 2. Rodar no seu computador
```bash
npm install
cp .env.example .env     # preencha com os dados do LiveKit
npm run dev              # precisa de Node 20.6 ou mais novo
```
Abra http://localhost:3000. Microfone e GPS funcionam em `localhost`.
Para testar com celulares reais é preciso **HTTPS**: faça o deploy (passo 3) ou use um túnel como ngrok.

## 3. Publicar a interface no GitHub Pages
O Pages hospeda somente arquivos estáticos. O servidor Node.js continua necessário para login, WebSocket, tokens do LiveKit e moderação; publique-o em Render, Railway ou Fly.io.

1. Em Render, crie um **Web Service** apontando para este repositório. Use `npm install` como build command e `npm start` como start command.
2. No serviço, configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ADMIN_KEY`, `ACCESS_CODE` e `ALLOWED_ORIGINS`. Para este repositório, a origem do Pages é `https://lobaque29.github.io` (sem `/bh-radio`). Inclua `http://localhost:3000` se também quiser testar localmente.
3. Em **Settings → Secrets and variables → Actions → Variables**, crie `BACKEND_URL` com a origem HTTPS do servidor, por exemplo `https://seu-app.onrender.com` (sem caminho final). É uma variável pública do frontend, não um segredo.
4. Em **Settings → Pages**, escolha **GitHub Actions** como fonte de publicação.
5. Faça push para `main`. O workflow só executa quando `BACKEND_URL` estiver definido; então valida a URL, instala as dependências, inclui o bundle do LiveKit e publica a pasta `public/`.
6. Se o Pages não permitir publicação enquanto o repositório for privado no seu plano, será necessário ajustar o plano ou a visibilidade do repositório.

O endereço do app será `https://lobaque29.github.io/bh-radio/`. O domínio do backend é uma configuração pública do frontend; as chaves do LiveKit e `ADMIN_KEY` ficam somente nas variáveis do servidor. No plano gratuito da Render o serviço pode dormir após inatividade.

Railway e Fly.io também podem hospedar o backend. Em qualquer plataforma, mantenha HTTPS e WebSocket habilitados.

## 4. Moderação (rotas /admin, header `x-admin-key`)
```bash
curl -H "x-admin-key: SUA_CHAVE" https://SEU-APP/admin/online
curl -H "x-admin-key: SUA_CHAVE" https://SEU-APP/admin/reports
curl -X POST -H "x-admin-key: SUA_CHAVE" -H "Content-Type: application/json" \
     -d '{"whatsapp":"5531999998888"}' https://SEU-APP/admin/ban
curl -X POST -H "x-admin-key: SUA_CHAVE" -H "Content-Type: application/json" \
     -d '{"whatsapp":"5531999998888"}' https://SEU-APP/admin/unban
```
Em hospedagem com disco temporário, `bans.json` pode sumir ao reiniciar; mantenha a lista também na variável `BANNED`.

## 5. Checklist antes de convidar o primeiro motoboy
- [ ] Consulta jurídica rápida: alertas de blitz e uso de fone ao conduzir
- [ ] Política de privacidade (LGPD) publicada e linkada; o texto de consentimento do login é um mínimo, não substitui isso
- [ ] Combinar regras do canal (sem xingamento, sem spam) e quem modera
- [ ] Testar com 3–4 aparelhos (Android e iPhone) em 4G, com capacete/ruído de moto
- [ ] Grupo pequeno (10–20 pessoas, 1–2 canais) por 2 semanas; medir atraso, clareza do áudio e quais alertas usam

## 6. Próximos passos
Medir o piloto → app nativo (serviço em segundo plano, PTT por volume/Bluetooth) → Pix (Mercado Pago/Asaas, depois Pix Automático) → lojas.

## Estrutura
```
server.js          servidor: login, tokens LiveKit, controle de palavra, alertas, admin
public/index.html  app do motoboy (tela de login + modo pilotagem)
public/manifest.json, sw.js, icon-*.png   PWA
```
O cliente do LiveKit é servido por `/vendor/livekit-client.js` (vem do pacote npm `livekit-client`, arquivo `dist/livekit-client.umd.js`). Se uma versão futura mudar esse nome, ajuste a rota em `server.js`.
