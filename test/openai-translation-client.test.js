import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITranslationClient } from '../src/translation/openai-translation-client.js';

const SERVICE = {
    apiURL: 'https://api.example.test/v1/chat/completions',
    apiKey: 'secret-token',
    model: 'test-model',
    maxRequestsPerSecond: 100,
    maxParagraphsPerRequest: 8,
    maxCharactersPerRequest: 6000,
    temperature: 0.2,
};

const SEGMENTS = [{
    id: 'segment-000001',
    source: 'Source paragraph.',
    kind: 'paragraph',
    headingPath: ['Methods'],
}];

function textResponse(body, status = 200, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    const response = streamResponse([bytes], status, headers);
    response.text = async () => text;
    response.arrayBuffer = async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    );
    return response;
}

function streamResponse(chunks, status = 200, headers = {}) {
    const values = new Map(
        Object.entries(headers).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
        ])
    );
    let index = 0;
    let cancelled = false;
    let cancelCalls = 0;
    let bodyCancelCalls = 0;
    let getReaderCalls = 0;
    let textCalls = 0;
    let arrayBufferCalls = 0;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: key => values.get(String(key).toLowerCase()) ?? null,
        },
        text: async () => {
            textCalls++;
            throw new Error('text() should not fully buffer oversized bodies');
        },
        arrayBuffer: async () => {
            arrayBufferCalls++;
            throw new Error('arrayBuffer() should not fully buffer streamed bodies');
        },
        body: {
            async cancel() {
                bodyCancelCalls++;
                cancelled = true;
            },
            getReader() {
                getReaderCalls++;
                return {
                    async read() {
                        if (cancelled || index >= chunks.length) {
                            return { done: true, value: undefined };
                        }
                        const value = chunks[index++];
                        return { done: false, value };
                    },
                    async cancel() {
                        cancelCalls++;
                        cancelled = true;
                    },
                };
            },
        },
        get textCalls() {
            return textCalls;
        },
        get arrayBufferCalls() {
            return arrayBufferCalls;
        },
        get cancelled() {
            return cancelled;
        },
        get cancelCalls() {
            return cancelCalls;
        },
        get bodyCancelCalls() {
            return bodyCancelCalls;
        },
        get getReaderCalls() {
            return getReaderCalls;
        },
    };
}

function nonStreamingResponse(body, status = 200, headers = {}) {
    const values = new Map(
        Object.entries(headers).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
        ])
    );
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    let textCalls = 0;
    let arrayBufferCalls = 0;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: key => values.get(String(key).toLowerCase()) ?? null,
        },
        async text() {
            textCalls++;
            return text;
        },
        async arrayBuffer() {
            arrayBufferCalls++;
            return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            );
        },
        get textCalls() {
            return textCalls;
        },
        get arrayBufferCalls() {
            return arrayBufferCalls;
        },
    };
}

function completion(translations) {
    return {
        choices: [{
            message: {
                content: JSON.stringify({ translations }),
            },
        }],
    };
}

function createClient(options = {}) {
    return new OpenAITranslationClient({
        createAbortController: () => new AbortController(),
        setTimeout,
        clearTimeout,
        sleep: async () => {},
        ...options,
    });
}

test('sends an OpenAI Chat Completions compatible request', async () => {
    const requests = [];
    const client = createClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return textResponse(completion([{
                id: 'segment-000001',
                text: '译文段落。',
            }]));
        },
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate accurately.',
        documentTitle: 'Paper',
        segments: SEGMENTS,
    });

    assert.deepEqual([...result], [['segment-000001', '译文段落。']]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, SERVICE.apiURL);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(
        requests[0].options.headers.Authorization,
        'Bearer secret-token'
    );
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, SERVICE.model);
    assert.equal(body.temperature, SERVICE.temperature);
    assert.equal(body.messages[1].role, 'user');
});

test('omits Authorization for a local service without an API key', async () => {
    let request;
    const client = createClient({
        fetch: async (_url, options) => {
            request = options;
            return textResponse(completion([{
                id: 'segment-000001',
                text: 'Translation.',
            }]));
        },
    });

    await client.translateBatch({
        service: {
            ...SERVICE,
            apiURL: 'http://localhost:1234/v1/chat/completions',
            apiKey: '',
        },
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });

    assert.equal('Authorization' in request.headers, false);
});

test('retries HTTP 429 and server errors up to the configured attempts', async () => {
    const responses = [
        textResponse('', 429, { 'retry-after': '0' }),
        textResponse('', 503),
        textResponse(completion([{
            id: 'segment-000001',
            text: 'Recovered translation.',
        }])),
    ];
    const delays = [];
    const client = createClient({
        fetch: async () => responses.shift(),
        sleep: async milliseconds => {
            delays.push(milliseconds);
        },
        retryBaseDelayMs: 25,
        maxAttempts: 3,
        now: () => 0,
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });

    assert.equal(result.get('segment-000001'), 'Recovered translation.');
    assert.ok(delays.includes(0));
    assert.ok(delays.includes(50));
});

test('does not retry authentication failures', async () => {
    let calls = 0;
    const client = createClient({
        fetch: async () => {
            calls++;
            return textResponse('', 401);
        },
        maxAttempts: 3,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_AUTHENTICATION_FAILED');
    assert.equal(calls, 1);
});

test('aborts an in-flight request through the caller signal', async () => {
    const caller = new AbortController();
    const client = createClient({
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new Error('fetch aborted'));
            }, { once: true });
        }),
    });
    const pending = client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
        signal: caller.signal,
    });
    caller.abort();

    await assert.rejects(
        () => pending,
        error => error.code === 'TRANSLATION_ABORTED'
            || error.name === 'AbortError'
    );
});

test('rejects malformed or oversized service responses', async () => {
    const client = createClient({
        fetch: async () => textResponse({
            choices: [{ message: { content: 'not-json' } }],
        }),
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_PROTOCOL_INVALID');
});

test('rejects declared Content-Length over the response budget before reading', async () => {
    let textCalls = 0;
    let arrayBufferCalls = 0;
    let response;
    const client = createClient({
        fetch: async () => {
            response = textResponse('{}', 200, {
                'content-length': String(5 * 1024 * 1024),
            });
            response.text = async () => {
                textCalls++;
                return '{}';
            };
            response.arrayBuffer = async () => {
                arrayBufferCalls++;
                return new ArrayBuffer(0);
            };
            return response;
        },
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_RESPONSE_TOO_LARGE');
    assert.equal(textCalls, 0);
    assert.equal(arrayBufferCalls, 0);
    assert.equal(response.cancelCalls, 1);
});

test('cancels streamed bodies that exceed the response budget without Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    const response = streamResponse([chunk, chunk, chunk, chunk, chunk]);
    const client = createClient({
        fetch: async () => response,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_RESPONSE_TOO_LARGE');
    assert.equal(response.cancelled, true);
    assert.equal(response.cancelCalls, 1);
    assert.equal(response.textCalls, 0);
    assert.equal(response.arrayBufferCalls, 0);
});

test('rejects misleading Content-Length when the streamed body exceeds the budget', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(66);
    const response = streamResponse(
        [chunk, chunk, chunk, chunk, chunk],
        200,
        { 'content-length': '128' }
    );
    const client = createClient({
        fetch: async () => response,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_RESPONSE_TOO_LARGE');
    assert.equal(response.cancelled, true);
    assert.equal(response.cancelCalls, 1);
});

test('rejects successful responses without a readable stream before buffering', async () => {
    const response = nonStreamingResponse(completion([{
        id: 'segment-000001',
        text: '译文段落。',
    }]));
    const client = createClient({
        fetch: async () => response,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_HTTP_RESPONSE_INVALID');
    assert.equal(response.textCalls, 0);
    assert.equal(response.arrayBufferCalls, 0);
});

test('classifies oversized error responses by HTTP status before size', async () => {
    const client = createClient({
        fetch: async () => textResponse('', 503, {
            'content-length': String(9 * 1024 * 1024),
        }),
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => (
        error.code === 'TRANSLATION_HTTP_ERROR'
        && error.status === 503
        && error.retryable === true
    ));
});

test('honours Retry-After on oversized HTTP error responses', async () => {
    const delays = [];
    const responses = [
        textResponse('', 429, {
            'content-length': String(9 * 1024 * 1024),
            'retry-after': '2',
        }),
        textResponse(completion([{
            id: 'segment-000001',
            text: 'Recovered translation.',
        }])),
    ];
    const client = createClient({
        fetch: async () => responses.shift(),
        sleep: async milliseconds => {
            delays.push(milliseconds);
        },
        maxAttempts: 2,
        now: () => 0,
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });
    assert.equal(result.get('segment-000001'), 'Recovered translation.');
    assert.ok(delays.includes(2000));
});

test('parses a streamed response within the response budget', async () => {
    const payload = JSON.stringify(completion([{
        id: 'segment-000001',
        text: '译文段落。',
    }]));
    const client = createClient({
        fetch: async () => streamResponse([new TextEncoder().encode(payload)]),
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });
    assert.deepEqual([...result], [['segment-000001', '译文段落。']]);
});

test('decodes multibyte response text split across stream chunks', async () => {
    const payload = JSON.stringify(completion([{
        id: 'segment-000001',
        text: '译文段落。',
    }]));
    const bytes = new TextEncoder().encode(payload);
    const split = bytes.indexOf(0xe8) + 1;
    const client = createClient({
        fetch: async () => streamResponse([
            bytes.slice(0, split),
            bytes.slice(split),
        ]),
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });
    assert.equal(result.get('segment-000001'), '译文段落。');
});

test('preserves size errors when stream cancellation is synchronous', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(67);
    const response = streamResponse([chunk, chunk, chunk, chunk, chunk]);
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = () => {
        const reader = getReader();
        reader.cancel = () => undefined;
        return reader;
    };
    const client = createClient({
        fetch: async () => response,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_RESPONSE_TOO_LARGE');
});

test('preserves size errors when stream cancellation rejects', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(68);
    const response = streamResponse([chunk, chunk, chunk, chunk, chunk]);
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = () => {
        const reader = getReader();
        reader.cancel = async () => {
            throw new Error('stream already errored');
        };
        return reader;
    };
    const client = createClient({
        fetch: async () => response,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_RESPONSE_TOO_LARGE');
});

test('reports timeouts that occur while reading the response body', async () => {
    let cancelCalls = 0;
    const client = createClient({
        fetch: async (_url, options) => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader() {
                    return {
                        read() {
                            return new Promise((_resolve, reject) => {
                                options.signal.addEventListener('abort', () => {
                                    reject(options.signal.reason);
                                }, { once: true });
                            });
                        },
                        async cancel() {
                            cancelCalls++;
                        },
                    };
                },
            },
        }),
        timeoutMs: 10,
        maxAttempts: 1,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => (
        error.code === 'TRANSLATION_TIMEOUT'
        && error.retryable === true
    ));
    assert.equal(cancelCalls, 1);
});

test('retries network failures that occur while reading the response body', async () => {
    let calls = 0;
    const client = createClient({
        fetch: async () => {
            calls++;
            if (calls === 1) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    body: {
                        getReader() {
                            return {
                                async read() {
                                    throw new Error('NS_ERROR_NET_RESET');
                                },
                                async cancel() {},
                            };
                        },
                    },
                };
            }
            return textResponse(completion([{
                id: 'segment-000001',
                text: 'Recovered translation.',
            }]));
        },
        maxAttempts: 2,
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });
    assert.equal(result.get('segment-000001'), 'Recovered translation.');
    assert.equal(calls, 2);
});

test('cancels a reader when the caller aborts during body streaming', async () => {
    const caller = new AbortController();
    let startReading;
    const reading = new Promise(resolve => {
        startReading = resolve;
    });
    let cancelCalls = 0;
    const client = createClient({
        fetch: async (_url, options) => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader() {
                    return {
                        read() {
                            startReading();
                            return new Promise((_resolve, reject) => {
                                options.signal.addEventListener('abort', () => {
                                    reject(options.signal.reason);
                                }, { once: true });
                            });
                        },
                        async cancel() {
                            cancelCalls++;
                        },
                    };
                },
            },
        }),
        maxAttempts: 1,
    });
    const pending = client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
        signal: caller.signal,
    });
    await reading;
    caller.abort();

    await assert.rejects(
        () => pending,
        error => error.code === 'TRANSLATION_ABORTED'
            || error.name === 'AbortError'
    );
    assert.equal(cancelCalls, 1);
});

test('computes HTTP-date Retry-After from the injected clock', async () => {
    const now = Date.UTC(2026, 7, 8, 7, 0, 0);
    const delays = [];
    const responses = [
        textResponse('', 429, {
            'retry-after': new Date(now + 2000).toUTCString(),
        }),
        textResponse(completion([{
            id: 'segment-000001',
            text: 'Recovered translation.',
        }])),
    ];
    const client = createClient({
        fetch: async () => responses.shift(),
        sleep: async milliseconds => {
            delays.push(milliseconds);
        },
        now: () => now,
        maxAttempts: 2,
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });
    assert.equal(result.get('segment-000001'), 'Recovered translation.');
    assert.ok(delays.includes(2000));
});

test('stops immediately when the service rejects its configuration', async () => {
    let calls = 0;
    const client = createClient({
        fetch: async () => {
            calls++;
            return textResponse('', 400);
        },
        maxAttempts: 4,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => (
        error.code === 'TRANSLATION_CONFIGURATION_INVALID'
        && error.status === 400
    ));
    assert.equal(calls, 1);
});

test('rate-limits actual request starts across concurrent batches', async () => {
    let clock = 0;
    const starts = [];
    const client = createClient({
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;
        },
        fetch: async (_url, options) => {
            starts.push(clock);
            const body = JSON.parse(options.body);
            const user = JSON.parse(body.messages[1].content);
            const id = user.segments[0].id;
            return textResponse(completion([{
                id,
                text: 'Translated.',
            }]));
        },
    });
    const service = {
        ...SERVICE,
        maxRequestsPerSecond: 2,
    };

    await Promise.all(Array.from({ length: 3 }, (_, index) => (
        client.translateBatch({
            service,
            targetLanguage: 'zh-CN',
            systemPrompt: 'Translate.',
            segments: [{
                ...SEGMENTS[0],
                id: 'segment-' + String(index + 1).padStart(6, '0'),
            }],
        })
    )));

    assert.deepEqual(starts, [0, 500, 1000]);
});

test('limits concurrent network requests to four', async () => {
    let active = 0;
    let maximumActive = 0;
    const pending = [];
    const client = createClient({
        maxConcurrency: 4,
        now: () => 0,
        sleep: async () => {},
        fetch: async (_url, options) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            const body = JSON.parse(options.body);
            const user = JSON.parse(body.messages[1].content);
            const id = user.segments[0].id;
            await new Promise(resolve => {
                pending.push(resolve);
            });
            active--;
            return textResponse(completion([{
                id,
                text: 'Translated.',
            }]));
        },
    });
    const service = {
        ...SERVICE,
        maxRequestsPerSecond: 1_000_000,
    };
    const requests = Array.from({ length: 6 }, (_, index) => (
        client.translateBatch({
            service,
            targetLanguage: 'zh-CN',
            systemPrompt: 'Translate.',
            segments: [{
                ...SEGMENTS[0],
                id: 'segment-' + String(index + 1).padStart(6, '0'),
            }],
        })
    ));
    for (let index = 0; index < 20 && pending.length < 4; index++) {
        await Promise.resolve();
    }

    assert.equal(active, 4);
    assert.equal(maximumActive, 4);
    pending.splice(0, 4).forEach(resolve => resolve());
    for (let index = 0; index < 20 && pending.length < 2; index++) {
        await Promise.resolve();
    }
    assert.equal(active, 2);
    pending.splice(0, 2).forEach(resolve => resolve());

    await Promise.all(requests);
    assert.equal(maximumActive, 4);
});
