const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const axios = require('axios');
const { PromisePool } = require('@supercharge/promise-pool');
const { EventEmitter } = require('events');
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const eventEmitter = new EventEmitter();

app.use(bodyParser.json());
app.use(express.static('public'));

const responseTimes = {};
const errorCount = {};
const requestCount = {};

function calculatePercentile(data, percentile) {
    data.sort((a, b) => a - b);
    const index = (percentile / 100) * data.length;
    const lower = Math.floor(index);
    const upper = lower + 1;
    const weight = index % 1;
    if (upper >= data.length) return data[lower];
    return data[lower] * (1 - weight) + data[upper] * weight;
}

class LoadTestRunner {
    static async loadTestApis(apiUrls, concurrency, duration, reqs) {
        const startTime = Date.now();
        for (const key in responseTimes) {
            delete responseTimes[key];
        }
        for (const key in errorCount) {
            delete errorCount[key];
        }
        for (const key in requestCount) {
            delete requestCount[key];
        }
        if (concurrency < 5) concurrency = 5;
        concurrency = concurrency * reqs;
        const promises = Array.from({ length: concurrency }, (_, i) => {
            return async () => {
                const apiUrl = apiUrls[i % apiUrls.length];
                if (!requestCount[apiUrl]) {
                    requestCount[apiUrl] = 0;
                }
                while (Date.now() - startTime < duration * 1000) {
                    const requestStartTime = Date.now();
                    try {
                        await axios.get(apiUrl);
                        const requestEndTime = Date.now();
                        const result = { success: true, responseTime: requestEndTime - requestStartTime, apiUrl };
                        eventEmitter.emit('requestCompleted', result);
                    } catch (error) {
                        const requestEndTime = Date.now();
                        const result = { success: false, responseTime: requestEndTime - requestStartTime, apiUrl };
                        eventEmitter.emit('requestCompleted', result);
                    }
                    requestCount[apiUrl]++;
                }
            };
        });

        await PromisePool
            .for(promises)
            .withConcurrency(concurrency)
            .process(async (result, processIndex, pool) => {
                return await result();
            });
    }

    static async startLoadTest(req, res) {
        const { urls, concurrency, duration, reqs } = req.body;
        try {
            const reqt = parseInt(reqs);
            await this.loadTestApis(urls, concurrency, duration, reqt);
            const averageResponseTimes = {};
            const errorRates = {};
            const requestsMade = {};
            const percentile97 = {};
            for (const url in responseTimes) {
                averageResponseTimes[url] = (responseTimes[url].reduce((acc, val) => acc + val, 0) / responseTimes[url].length).toFixed(2);
                const totalRequests = requestCount[url] || 0;
                const errors = errorCount[url] || 0;
                errorRates[url] = ((errors / totalRequests) * 100).toFixed(2);
                requestsMade[url] = totalRequests;
                percentile97[url] = calculatePercentile(responseTimes[url], 97).toFixed(2);
            }
            io.emit('loadTestCompleted', {
                message: "Load test completed.",
                averageResponseTimes,
                errorRates,
                requestsMade,
                percentile97
            });
            res.status(200).send("Load test completed.");
        } catch (error) {
            console.error(error);
            res.status(500).send("Internal server error.");
        }
    }
}

eventEmitter.on('requestCompleted', (result) => {
    if (result && result.apiUrl) {
        responseTimes[result.apiUrl] = responseTimes[result.apiUrl] || [];
        responseTimes[result.apiUrl].push(result.responseTime);
        if (!result.success) {
            errorCount[result.apiUrl] = (errorCount[result.apiUrl] || 0) + 1;
        }
        const avgResponseTime = responseTimes[result.apiUrl].reduce((acc, val) => acc + val, 0) / responseTimes[result.apiUrl].length;
        const errorRate = errorCount[result.apiUrl] ? (errorCount[result.apiUrl] / (requestCount[result.apiUrl] || 1)) * 100 : 0;
        const percentile = calculatePercentile(responseTimes[result.apiUrl], 97);

        console.log(`Percentile 97th: ${percentile.toFixed(2)}`);
        console.log(`Request to ${result.apiUrl} completed. Success: ${result.success}. Res time: ${result.responseTime} ms.`);

        io.emit('requestUpdate', {
            url: result.apiUrl,
            requestsMade: requestCount[result.apiUrl] || 0,
            errorRate: errorRate,
            averageResponseTime: avgResponseTime,
            percentile97: percentile
        });
    } else {
        console.error('Invalid result object:', result);
    }
});

app.post('/startLoadTest', LoadTestRunner.startLoadTest.bind(LoadTestRunner));

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
