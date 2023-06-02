import path from 'path';
import fs from 'fs';
import cookie from 'cookie';
import Bcrypt from 'bcryptjs';


const dev = process.env.BUN_ENV !== 'production';
globalThis.BASE_URL = process.env.BASE_URL||'/';
globalThis.API_URL = process.env.BASE_URL||'/api';

export class Context {
    constructor(req) {
        this.req = req;
        this.parsedUrl = new URL(req.url)

        const res = {status: 200}

        this.res = () => res;
        this.res.headers = new Headers()
        this.res.beforeSend = []

        this.res.status = (code) => {
            res.status = code;
            return this.res
        }

        this.res.cookie = (key, value = '', opts = {}) => {
            let cookieStr;
            opts.path = API_URL;
            if (!value) {
                cookieStr = `${key}=; Path=${opts.path}; MaxAge=0; HttpOnly`;
            } else {
                opts.httpOnly = true;
                cookieStr = cookie.serialize(key, value, opts)
            }
            this.res.headers.append('Set-Cookie', cookieStr)
            return this.res
        }
    }
}


export async function serveResource(ctx) {
    dev && console.info({ctx})

    if (ctx.parsedUrl.pathname.slice(0, API_URL.length) !== API_URL) {
        return;
    }

    await parse(ctx)
    const { service, actionArgs } = await getService(ctx)

    if (!service) {
        return new Response('', {status: 404})
    }

    const action = 'onRequest' + ctx.req.method[0] + ctx.req.method.slice(1).toLowerCase()

    if (!service[action]) {
        return new Response('', {
            status: 405,
            headers: {Allow: getAllowedMethods(service)}
        })
    }

    if (['GET', 'PATCH', 'DELETE'].includes(ctx.req.method) && actionArgs.id) {
        ctx.req.params.set('id', actionArgs.id)
    }

    ctx.res.data = await service[action](ctx.req, ctx.res)

    const res = ctx.res()

    if (res.status >= 400) {
        ctx.res.data = '';
    } else {
        service.afterAction(ctx)
    }

    return new Response(ctx.res.data, {
        status: res.status || {POST:201, DELETE:204}[ctx.req.method] || 200,
        headers: ctx.res.headers
    })
}

function getAllowedMethods(service) {
    if (!service.actions) {
        service.actions = []
        for (let _method of ['Get', 'Post', 'Put', 'Patch', 'Delete']) {
            if (service['onRequest'+_method]) {
                service.actions.push(_method.toUpperCase())
            }
        }
        service.actions = service.actions.join(', ')
    }
    return service.actions
}

async function parse(ctx) {
    ctx.req.cookies = cookie.parse(ctx.req.headers.get('cookie') ||'')
    ctx.req.params = ctx.parsedUrl.searchParams

    //@TODO: use client IP address for client_id, but not supported by Web API
    if (!ctx.req.clientID) {
        ctx.req.clientID = ctx.req.cookies.cid
        ctx.req.generateCID = _ => ctx.res.cookie('cid', Buffer.from(Bcrypt.genSaltSync()).toString('base64').slice(0, 20))
    }

    if (['POST', 'PATCH', 'PUT'].includes(ctx.req.method)) {
        ctx.req.bodyParsed = await ctx.req.formData().then(d => d.toJSON())
    }
}


const services = {}

async function getService(ctx) {
    let route = ctx.parsedUrl.pathname.slice(API_URL.length)
    let service = services[route]
    const dir = path.join(__dirname, 'services')
    const actionArgs = {}

    dev && console.info({dir, route, service})

    if (!service) {
        service = services[route] = await import(`${dir}${route}.js`).then(prepareService).catch(_ => void 0)
        if (!service) {
            const slashPos = route.lastIndexOf('/')
            if (slashPos > 1) {
                actionArgs.id = route.slice(slashPos + 1)
                route = route.slice(0, slashPos)
                service = services[route] = await import(`${dir}${route}.js`).then(prepareService).catch(_ => void 0)
            }
        }
    }

    return {service, actionArgs}
}

function prepareService(x) {
    x.default.afterAction = (ctx) => {
        ctx.res.beforeSend.forEach(fn => fn())
        jsonResponse(ctx.res)
    }
    return x.default
}

function jsonResponse(res) {
    res.headers.set('Content-Type', 'application/json')
    res.data = JSON.stringify(res.data)
}


const root = path.join(__dirname, '/../dist/client')

function serveStatic(ctx) {
    const file = root + ctx.parsedUrl.pathname;

    try {
        if (fs.statSync(file).isFile()) {
            return new Response(Bun.file(file))
        }
    } catch (err) {
        // console.error('error serveStatic', {...err, file})
    }
}

function runMiddleware(fns, ctx) {
    if (!fns.length) {
        return;
    }

    // @ts-ignore
    const result = fns.shift().call({}, ctx)

    if (!result) {
        return runMiddleware(fns, ctx)
    }

    if (result instanceof Response) {
        return result;
    }

    if (result && result.then) {
        return result
            .then(res => res || runMiddleware(fns, ctx))
            .catch(err => {
                if (!err.status) {
                    console.error(err)
                    err.status = 500;
                    err.detail = err.message;
                } else {
                    // err.detail = afterAction(err.detail)
                }
                return new Response(err.detail, err)
            })
    }
}


const {SERVER_HOST: hostname, SERVER_PORT: port} = process.env;

dev || console.log(`Server running on ${hostname}:${port}`);

export default {
    fetch(req) {
        console.info('FetchEvent:',req.url)
        const ctx = new Context(req)

        return runMiddleware([
            serveStatic,
            serveResource,
            _ => new Response(Bun.file(root + '/index.html'))
        ], ctx)
    },

    // this is called when fetch() throws or rejects
    // error(err: Error) {
    // return new Response("uh oh! :(" + String(err.toString()), { status: 500 });
    // },

    // this boolean enables the bun's default error handler
    // sometime after the initial release, it will auto reload as well
    development: dev,
    // note: this isn't node, but for compatibility bun supports process.env + more stuff in process

    // SSL is enabled if these two are set
    // certFile: './cert.pem',
    // keyFile: './key.pem',

    port, // number or string
    hostname, // defaults to 0.0.0.0
}