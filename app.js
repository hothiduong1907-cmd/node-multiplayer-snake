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
    ]).then((results) => {
        const appEnvSecret = results[0];
        const cosmosKeySecret = results[1];
        const cosmosEndpointSecret = results[2];
        const storageConnStringSecret = results[3];
        const appInsightsConnStringSecret = results[4];

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
    }).catch((error) => {
        console.error('Lỗi khi kết nối Key Vault/Cosmos DB:', error.message);
    });
}


app.use(express.json());

app.get('/health', (request, response) => {
    response.json({
        status: 'ok',
        keyVaultSecretLoaded: secretsLoaded,
        cosmosConnected: cosmosContainer !== null,
        storageConnected: containerClient !== null,
        appInsightsConnected,
    });
});

app.post('/api/score', (request, response) => {
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
    return cosmosContainer.items.create(item).then(() => {
        response.json({ success: true, item });
    }).catch((error) => {
        response.status(500).json({ error: error.message });
    });
});

app.get('/api/leaderboard', (request, response) => {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    return cosmosContainer.items
        .query('SELECT TOP 10 * FROM c ORDER BY c.score DESC')
        .fetchAll()
        .then((result) => {
            response.json(result.resources);
        })
        .catch((error) => {
            response.status(500).json({ error: error.message });
        });
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

function saveScoreToLeaderboard(playerName, score) {
    if (!cosmosContainer) {
        return;
    }
    const item = {
        id: `${playerName}-${Date.now()}`,
        playerName,
        score,
        createdAt: new Date().toISOString(),
    };
    cosmosContainer.items.create(item).catch((error) => {
        console.error('Lỗi khi lưu điểm tự động:', error.message);
    });
}

async function startServer() {
    await initWebPubSub();

    const gameController = new GameController(saveScoreToLeaderboard);
    gameController.listen(io);


    initAzureServices(); // Key Vault/Cosmos/Storage/AppInsights — không cần chặn server start

    server.listen(app.get('port'), () => {
        console.log('Express server listening on port %d in %s mode', app.get('port'), app.get('env'));
    });
}

startServer();

module.exports = app;
