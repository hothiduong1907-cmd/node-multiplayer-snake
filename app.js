'use strict';
const path = require('path');
const appInsights = require('applicationinsights');
const GameController = require('./app/controllers/game-controller');
const express = require('express');
const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const { useAzureSocketIO } = require('@azure/web-pubsub-socket.io');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const Redis = require('ioredis');
const { EventGridPublisherClient, AzureKeyCredential } = require('@azure/eventgrid');
const { EmailClient } = require('@azure/communication-email');
const { SearchClient, AzureKeyCredential: SearchKeyCredential } = require('@azure/search-documents');
async function initWebPubSub() {
    if (process.env.WEB_PUBSUB_CONNECTION_STRING) {
        try {
            await useAzureSocketIO(io, {
                hub: 'snakeHub',
                connectionString: process.env.WEB_PUBSUB_CONNECTION_STRING,
            });
            console.log('Web PubSub enabled — multi-instance sync active');
        } catch (err) {
            console.error('Lỗi khởi tạo Web PubSub:', err.message);
        }
    } else {
        console.log('Web PubSub connection string not found — running in single-instance mode');
    }
}
const favicon = require('serve-favicon');
const lessMiddleware = require('less-middleware');

app.use(lessMiddleware(path.join(__dirname, 'public')));
// Expose all static resources in /public
app.use(express.static(path.join(__dirname, 'public')));
app.use(favicon(path.join(__dirname, 'public', 'favicon.png')));

// Redirect to the main page
app.get('/', (request, response) => {
    response.sendFile('game.html', { root: path.join(__dirname, 'app/views') });
});

// Create the main controller
const KEY_VAULT_URL = 'https://kv-snake-1.vault.azure.net/';
let cosmosContainer = null;
let containerClient = null;
let redisClient = null;
let redisConnected = false;
let eventGridClient = null;
let eventGridConnected = false;
let translatorConfig = null;
let translatorConnected = false;
let emailClient = null;
let emailSenderAddress = null;
let communicationConnected = false;
let searchClient = null;
let searchConnected = false;
const LEADERBOARD_CACHE_KEY = 'leaderboard:top10';
const LEADERBOARD_CACHE_TTL_SECONDS = 30;
let secretsLoaded = false;
let appInsightsConnected = false;
function initAzureServices() {
    const credential = new DefaultAzureCredential();
    const secretClient = new SecretClient(KEY_VAULT_URL, credential);

  Promise.all([
        secretClient.getSecret('AppEnv'),
        secretClient.getSecret('CosmosDbKey'),
        secretClient.getSecret('CosmosDbEndpoint'),
        secretClient.getSecret('StorageConnectionString'),
        secretClient.getSecret('AppInsightsConnectionString'),
        secretClient.getSecret('RedisHost'),
        secretClient.getSecret('RedisPort'),
        secretClient.getSecret('RedisKey'),
        secretClient.getSecret('EventGridTopicEndpoint'),
        secretClient.getSecret('EventGridTopicKey'),
        secretClient.getSecret('TranslatorKey'),
        secretClient.getSecret('TranslatorEndpoint'),
        secretClient.getSecret('TranslatorRegion'),
        secretClient.getSecret('CommunicationConnectionString'),
        secretClient.getSecret('CommunicationSenderAddress'),
    ]).then((results) => {
        const appEnvSecret = results[0];
        const cosmosKeySecret = results[1];
        const cosmosEndpointSecret = results[2];
        const storageConnStringSecret = results[3];
        const appInsightsConnStringSecret = results[4];
        const redisHostSecret = results[5];
        const redisPortSecret = results[6];
        const redisKeySecret = results[7];
        const eventGridEndpointSecret = results[8];
        const eventGridKeySecret = results[9];
        const translatorKeySecret = results[10];
        const translatorEndpointSecret = results[11];
        const translatorRegionSecret = results[12];
        const communicationConnStringSecret = results[13];
        const communicationSenderSecret = results[14];

        console.log('Đã đọc secret AppEnv từ Key Vault:', appEnvSecret.value);
        secretsLoaded = true;

        const cosmosClient = new CosmosClient({
            endpoint: cosmosEndpointSecret.value,
            key: cosmosKeySecret.value,
        });
        const database = cosmosClient.database('SnakeDB');
        cosmosContainer = database.container('Leaderboard');
        console.log('Đã kết nối Cosmos DB thành công');

        const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnStringSecret.value);
        containerClient = blobServiceClient.getContainerClient('game-logs');
        containerClient.createIfNotExists().then(() => {
            console.log('Đã kết nối Storage Account thành công');
        });
        appInsights.setup(appInsightsConnStringSecret.value)
            .setAutoCollectRequests(true)
            .setAutoCollectExceptions(true)
            .setAutoCollectConsole(true, true)
            .start();
        appInsightsConnected = true;
        console.log('Đã kết nối Application Insights thành công');

        redisClient = new Redis({
            host: redisHostSecret.value.trim(),
            port: Number(redisPortSecret.value.trim()),
            password: redisKeySecret.value.trim(),
            tls: {},
        });
        redisClient.on('connect', () => {
            redisConnected = true;
            console.log('Đã kết nối Azure Managed Redis thành công');
        });
        redisClient.on('error', (err) => {
            redisConnected = false;
            console.error('Lỗi kết nối Redis:', err.message);
        });
        try {
            eventGridClient = new EventGridPublisherClient(
                eventGridEndpointSecret.value.trim(),
                'EventGrid',
                new AzureKeyCredential(eventGridKeySecret.value.trim())
            );
            eventGridConnected = true;
            console.log('Đã khởi tạo Event Grid client thành công');
        } catch (err) {
            eventGridConnected = false;
            console.error('Lỗi khởi tạo Event Grid:', err.message);
        }
        translatorConfig = {
            key: translatorKeySecret.value.trim(),
            endpoint: translatorEndpointSecret.value.trim().replace(/\/$/, ''),
            region: translatorRegionSecret.value.trim(),
        };
        translatorConnected = true;
        console.log('Đã cấu hình Azure AI Translator thành công');

        try {
            emailClient = new EmailClient(communicationConnStringSecret.value.trim());
            emailSenderAddress = communicationSenderSecret.value.trim();
            communicationConnected = true;
            console.log('Đã khởi tạo Communication Services (Email) thành công');
        } catch (err) {
            communicationConnected = false;
            console.error('Lỗi khởi tạo Communication Services:', err.message);
        }
    }).catch((error) => {
        console.error('Lỗi khi kết nối Key Vault/Cosmos DB:', error.message);
    });
}

function initAzureSearch() {
    const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const apiKey = process.env.AZURE_SEARCH_ADMIN_KEY;
    const indexName = process.env.AZURE_SEARCH_INDEX || 'leaderboard';

    if (!endpoint || !apiKey) {
        console.log('Azure AI Search chưa được cấu hình (thiếu AZURE_SEARCH_ENDPOINT hoặc AZURE_SEARCH_ADMIN_KEY)');
        return;
    }

    try {
        searchClient = new SearchClient(endpoint, indexName, new SearchKeyCredential(apiKey));
        searchConnected = true;
        console.log('Đã kết nối Azure AI Search thành công');
    } catch (error) {
        searchConnected = false;
        console.error('Lỗi khởi tạo Azure AI Search:', error.message);
    }
}

app.use(express.json());

app.get('/health', (request, response) => {
    response.json({
        status: 'ok',
        keyVaultSecretLoaded: secretsLoaded,
        cosmosConnected: cosmosContainer !== null,
        storageConnected: containerClient !== null,
        appInsightsConnected,
        redisConnected,
        eventGridConnected,
        translatorConnected,
        communicationConnected,
        searchConnected,
    });
});

app.post('/api/score', async (request, response) => {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    const { playerName, score } = request.body;
    if (!playerName || score === undefined) {
        return response.status(400).json({ error: 'Thiếu playerName hoặc score' });
    }
    const item = {
        id: `${playerName}-${Date.now()}`,
        playerName,
        score,
        createdAt: new Date().toISOString(),
    };

    // Đọc kỷ lục CŨ trước khi ghi điểm mới — bắt buộc phải await để tránh race condition
    const previousMax = await getCurrentMaxScore();

    try {
        await cosmosContainer.items.create(item);
        if (redisClient && redisConnected) {
            redisClient.del(LEADERBOARD_CACHE_KEY).catch(() => {});
        }
        response.json({ success: true, item });
    } catch (error) {
        return response.status(500).json({ error: error.message });
    }

    if (score > previousMax) {
        publishHighScoreEvent(playerName, score, previousMax);
    }
});

app.get('/api/leaderboard', async (request, response) => {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }

    if (redisClient && redisConnected) {
        try {
            const cached = await redisClient.get(LEADERBOARD_CACHE_KEY);
            if (cached) {
                response.set('X-Cache', 'HIT');
                return response.json(JSON.parse(cached));
            }
        } catch (error) {
            console.error('Lỗi đọc cache Redis:', error.message);
        }
    }

    return cosmosContainer.items
        .query('SELECT TOP 10 * FROM c ORDER BY c.score DESC')
        .fetchAll()
        .then((result) => {
            response.set('X-Cache', 'MISS');
            response.json(result.resources);

            if (redisClient && redisConnected) {
                redisClient.set(
                    LEADERBOARD_CACHE_KEY,
                    JSON.stringify(result.resources),
                    'EX',
                    LEADERBOARD_CACHE_TTL_SECONDS
                ).catch((error) => {
                    console.error('Lỗi ghi cache Redis:', error.message);
                });
            }
        })
       .catch((error) => {
            response.status(500).json({ error: error.message });
        });
});

app.get('/api/leaderboard/search', async (request, response) => {
    if (!searchClient || !searchConnected) {
        return response.status(503).json({ error: 'Azure AI Search chưa kết nối' });
    }
    const { q, minScore, level } = request.query;
    const filterParts = [];
    if (minScore) filterParts.push(`score ge ${Number(minScore)}`);
    if (level) filterParts.push(`level eq '${level}'`);

    try {
        const searchResults = await searchClient.search(q ? `${q}*` : '*', {
            queryType: 'full',
            filter: filterParts.length ? filterParts.join(' and ') : undefined,
            orderBy: ['score desc'],
            top: 10,
        });
        const items = [];
        for await (const result of searchResults.results) {
            items.push(result.document);
        }
        response.json(items);
    } catch (error) {
        response.status(500).json({ error: error.message });
    }
});

app.get('/api/leaderboard/suggest', async (request, response) => {
    if (!searchClient || !searchConnected) {
        return response.status(503).json({ error: 'Azure AI Search chưa kết nối' });
    }
    const { q } = request.query;
    if (!q) {
        return response.json([]);
    }
    try {
        const suggestions = await searchClient.suggest(q, 'playerSuggester', { top: 5 });
        response.json(suggestions.results.map((r) => r.text));
    } catch (error) {
        response.status(500).json({ error: error.message });
    }
});

app.post('/api/webhook/high-score', (request, response) => {
    const events = Array.isArray(request.body) ? request.body : [request.body];

    // Bước xác thực bắt buộc khi tạo Event Grid Subscription lần đầu (validation handshake)
    const validationEvent = events.find((e) => e.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
    if (validationEvent) {
        console.log('Event Grid subscription validation received');
        return response.json({ validationResponse: validationEvent.data.validationCode });
    }

    events.forEach((event) => {
       if (event.eventType === 'Snake.PlayerHighScore') {
            console.log('[Webhook] Nhận sự kiện phá kỷ lục:', JSON.stringify(event.data));
            const { playerName, score } = event.data;
            const message = `New high score: ${playerName} - ${score} points!`;
            translateText(message, 'id').then((translated) => {
                if (translated) {
                    console.log(`[Webhook] Bản dịch tiếng Indonesia: "${translated}"`);
                    // Bước tiếp theo (Communication Services gửi email) sẽ được nối vào đây
                } else {
                    console.log('[Webhook] Dịch thất bại, dùng bản gốc tiếng Anh.');
                }
                sendHighScoreEmail(
                    'hothiduong1907@gmail.com',
                    `🎉 Kỷ lục mới: ${playerName}`,
                    finalMessage
                );
            });
        }
    });
    response.status(200).send();
});

app.post('/api/log', (request, response) => {
    if (!containerClient) {
        return response.status(503).json({ error: 'Storage chưa kết nối' });
    }
    const content = JSON.stringify({ event: request.body.event || 'test', time: new Date().toISOString() });
    const blobName = `log-${Date.now()}.json`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    return blockBlobClient.upload(content, content.length).then(() => {
        response.json({ success: true, blobName });
    }).catch((error) => {
        response.status(500).json({ error: error.message });
    });
});

const SERVER_PORT = process.env.PORT || 3000;
app.set('port', SERVER_PORT);

async function getCurrentMaxScore() {
    if (!cosmosContainer) {
        return 0;
    }
    try {
        const result = await cosmosContainer.items
            .query('SELECT VALUE MAX(c.score) FROM c')
            .fetchAll();
        return (result.resources && result.resources[0]) || 0;
    } catch (error) {
        console.error('Lỗi đọc kỷ lục hiện tại:', error.message);
        return 0;
    }
}

async function translateText(text, toLang) {
    if (!translatorConfig || !translatorConnected) {
        return null;
    }
    try {
        const url = `${translatorConfig.endpoint}/translate?api-version=3.0&to=${toLang}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': translatorConfig.key,
                'Ocp-Apim-Subscription-Region': translatorConfig.region,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([{ Text: text }]),
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error('Translator API lỗi:', res.status, errText);
            return null;
        }
        const data = await res.json();
        return data[0]?.translations[0]?.text || null;
    } catch (error) {
        console.error('Lỗi gọi Translator:', error.message);
        return null;
    }
}

async function sendHighScoreEmail(toAddress, subject, body) {
    if (!emailClient || !communicationConnected) {
        return;
    }
    try {
        const poller = await emailClient.beginSend({
            senderAddress: emailSenderAddress,
            content: { subject, plainText: body },
            recipients: { to: [{ address: toAddress }] },
        });
        const result = await poller.pollUntilDone();
        console.log('Đã gửi email thành công, status:', result.status);
    } catch (error) {
        console.error('Lỗi gửi email:', error.message);
    }
}

async function publishHighScoreEvent(playerName, score, previousMax) {
    if (!eventGridClient || !eventGridConnected) {
        return;
    }
    try {
        await eventGridClient.send([{
            eventType: 'Snake.PlayerHighScore',
            subject: `players/${playerName}`,
            dataVersion: '1.0',
            data: { playerName, score, previousMax },
        }]);
        console.log(`Event published: ${playerName} phá kỷ lục với ${score} điểm (kỷ lục cũ: ${previousMax})`);
    } catch (error) {
        console.error('Lỗi publish Event Grid:', error.message);
    }
}
async function saveScoreToLeaderboard(playerName, score) {
    if (!cosmosContainer) {
        return;
    }
    const previousMax = await getCurrentMaxScore();
    const item = {
        id: `${playerName}-${Date.now()}`,
        playerName,
        score,
        createdAt: new Date().toISOString(),
    };
    try {
        await cosmosContainer.items.create(item);
        if (redisClient && redisConnected) {
            redisClient.del(LEADERBOARD_CACHE_KEY).catch(() => {});
        }
    } catch (error) {
        console.error('Lỗi khi lưu điểm tự động:', error.message);
        return;
    }

    if (searchClient && searchConnected) {
        try {
            await searchClient.uploadDocuments([{
                id: item.id.replace(/[^a-zA-Z0-9_\-=]/g, '_'),
                playerName: item.playerName,
                score: item.score,
                level: 'multiplayer',
                playedAt: item.createdAt,
                durationSec: 0,
            }]);
        } catch (error) {
            console.error('Lỗi đẩy dữ liệu vào Azure Search:', error.message);
        }
    }

    if (score > previousMax) {
        publishHighScoreEvent(playerName, score, previousMax);
    }
}

async function startServer() {
    await initWebPubSub();

    const gameController = new GameController(saveScoreToLeaderboard);
    gameController.listen(io);


    initAzureServices(); // Key Vault/Cosmos/Storage/AppInsights — không cần chặn server start
    initAzureSearch();
    
    server.listen(app.get('port'), () => {
        console.log('Express server listening on port %d in %s mode', app.get('port'), app.get('env'));
    });
}

startServer();

module.exports = app;
