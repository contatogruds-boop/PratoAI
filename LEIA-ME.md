# Prato — ligar à API de IA

Este projeto usa a API da OpenAI em duas chamadas: a Responses API lê a foto/PDF e devolve os pratos num JSON estruturado; a ferramenta de geração de imagem cria uma foto para cada prato.

## Rodar localmente

1. Instale Node.js 20 ou mais recente.
2. Abra um terminal nesta pasta e execute `npm install`.
3. Copie `.env.example` para `.env` e substitua `cole_sua_chave_aqui` por uma chave criada no painel da OpenAI Platform.
4. Execute `npm start` e abra `http://localhost:3000`.

A chave fica no servidor e não deve ser colocada no `index.html`. As chamadas de API geram custos na conta da OpenAI Platform.

## Como os arquivos se conectam

- `index.html` envia a imagem para `POST /api/process-menu`.
- `server.mjs` envia a foto/PDF à Responses API, pede os pratos e preços em JSON e devolve o resultado à página.
- Para cada prato, a página chama `POST /api/generate-image`; o servidor pede uma imagem, salva em `generated/` e devolve o endereço para a página.

## Publicar e gerar o QR Code

Depois de reconhecer o cardápio e gerar as imagens, informe o nome do restaurante e clique em **Publicar meu cardápio**. O servidor salva os dados em `data/menus.json`, cria uma página pública em `/m/<id>` e mostra um QR Code PNG para baixar. A biblioteca `qrcode` gera o PNG no servidor.

Para o QR Code funcionar no celular dos clientes, hospede o site num domínio público e configure `PUBLIC_BASE_URL=https://seu-dominio.com` no `.env` de produção. Não use `localhost` no QR impresso: esse endereço só funciona no computador que está rodando o servidor. Configure também armazenamento persistente para as imagens e os dados; os arquivos locais deste protótipo podem ser apagados ou não sobreviver a uma troca de servidor.

Antes de vender o serviço para vários restaurantes, adicione login, separação de dados por cliente, limite de uso/custos por conta, política de retenção/remoção e armazenamento durável. O servidor inicial está preparado para desenvolvimento e demonstração, não para exposição pública sem esses controles.
