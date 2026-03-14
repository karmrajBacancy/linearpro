const cors_anywhere = require('cors-anywhere');

const host = '127.0.0.1';
const port = 8080;

cors_anywhere.createServer({
    originWhitelist: [],
    requireHeader: [],
    removeHeaders: ['cookie', 'cookie2']
}).listen(port, host, () => {
    console.log(`CORS proxy running on http://${host}:${port}`);
});
