'use strict';
const path = require('path');
const GameController = require('./app/controllers/game-controller');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const { useAzureSocketIO } = require('@azure/web-pubsub-socket.io');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { CosmosClient } = require('@azure/cosmos');
if (process.env.WEB_PUBSUB_CONNECTION_STRING) {
    useAzureSocketIO(io, {
        hub: 'snakeHub',
        connectionString: process.env.WEB_PUBSUB_CONNECTION_STRING,
    });
    console.log('Web PubSub enabled — multi-instance sync active');
} else {
    console.log('Web PubSub connection string not found — running in single-instance mode');
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
const gameController = new GameController();
gameController.listen(io);
const KEY_VAULT_URL = 'https://kv-snake-1907.vault.azure.net/';
let cosmosContainer = null;
let secretsLoaded = false;

function initAzureServices() {
    var credential = new DefaultAzureCredential();
    var secretClient = new SecretClient(KEY_VAULT_URL, credential);

    Promise.all([
        secretClient.getSecret('AppEnv'),
        secretClient.getSecret('CosmosDbKey'),
        secretClient.getSecret('CosmosDbEndpoint')
    ]).then(function (results) {
        var appEnvSecret = results[0];
        var cosmosKeySecret = results[1];
        var cosmosEndpointSecret = results[2];

        console.log('Đã đọc secret AppEnv từ Key Vault:', appEnvSecret.value);
        secretsLoaded = true;

        var cosmosClient = new CosmosClient({
            endpoint: cosmosEndpointSecret.value,
            key: cosmosKeySecret.value,
        });
        var database = cosmosClient.database('SnakeDB');
        cosmosContainer = database.container('Leaderboard');
        console.log('Đã kết nối Cosmos DB thành công');
    }).catch(function (error) {
        console.error('Lỗi khi kết nối Key Vault/Cosmos DB:', error.message);
    });
}

initAzureServices();

app.use(express.json());

app.get('/health', (request, response) => {
    response.json({
        status: 'ok',
        keyVaultSecretLoaded: secretsLoaded,
        cosmosConnected: cosmosContainer !== null,
    });
});

app.post('/api/score', function (request, response) {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    var playerName = request.body.playerName;
    var score = request.body.score;
    if (!playerName || score === undefined) {
        return response.status(400).json({ error: 'Thiếu playerName hoặc score' });
    }
    var item = { id: playerName + '-' + Date.now(), playerName: playerName, score: score, createdAt: new Date().toISOString() };
    cosmosContainer.items.create(item).then(function () {
        response.json({ success: true, item: item });
    }).catch(function (error) {
        response.status(500).json({ error: error.message });
    });
});

app.get('/api/leaderboard', function (request, response) {
    if (!cosmosContainer) {
        return response.status(503).json({ error: 'Cosmos DB chưa kết nối' });
    }
    cosmosContainer.items
        .query('SELECT TOP 10 * FROM c ORDER BY c.score DESC')
        .fetchAll()
        .then(function (result) {
            response.json(result.resources);
        })
        .catch(function (error) {
            response.status(500).json({ error: error.message });
        });
});
const SERVER_PORT = process.env.PORT || 3000;
app.set('port', SERVER_PORT);

// Start Express server
server.listen(app.get('port'), () => {
    console.log('Express server listening on port %d in %s mode', app.get('port'), app.get('env'));
});

module.exports = app;
