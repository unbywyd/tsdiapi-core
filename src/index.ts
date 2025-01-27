import 'reflect-metadata';
import path from 'path';

import express from 'express'
import cors from 'cors';
import {
    getMetadataArgsStorage,
    useContainer as routingControllersUseContainer,
    useExpressServer,
} from 'routing-controllers'
import { routingControllersToSpec } from 'routing-controllers-openapi'
import { initAppModule, getConfig, environment, AppConfig, AppDir } from "./modules/app";
initAppModule({
    appCwd: process.cwd()
});
import { validationMetadatasToSchemas } from 'class-validator-jsonschema'
import serverOptions from './config/server.config';
import corsOptions from './config/cors.config';
import swaggerOptions from './config/swagger.config';
import { createLogger, logger } from './modules/logger';
import { loadMorganModule } from './modules/morgan';
import { loadHelmetModule } from './modules/helmet';
import { createServer } from 'http'
import * as swaggerUiExpress from 'swagger-ui-express'
import fileLoader from './modules/file-loader'
import { AsyncResolver } from 'routing-controllers-openapi-extra';
import Container from 'typedi';
import { AppContext, AppOptions, AppPlugin, CreateAppOptions } from './types';
export * from './types';

const appDefaultOptions: AppOptions = {
    appConfig: AppConfig,
    environment,
    corsOptions,
    swaggerOptions,
}

export async function createApp(options?: CreateAppOptions) {
    try {
        const appOptions = typeof options?.config === 'function' ? options.config(appDefaultOptions) : options?.config ? { ...appDefaultOptions, ...options.config } : appDefaultOptions;
        const app: express.Application = express();
        const context: AppContext = {
            app,
            apiDir: AppDir + '/api',
            appDir: AppDir,
            container: Container,
            config: appOptions,
            logger: createLogger({ baseDir: appOptions?.loggerOptions?.baseDir || 'logs' }),
            plugins: {} as Record<string, AppPlugin>
        }
        if (options?.plugins && options.plugins.length > 0) {
            for (const plugin of options.plugins) {
                if (plugin) {
                    context.plugins[plugin.name] = plugin;
                }
            }
            for (const plugin of options.plugins) {
                if (plugin.onInit) {
                    try {
                        await plugin.onInit(context);
                    } catch (error) {
                        console.error(`Plugin ${plugin.name} onInit error:`, error);
                    }
                }
                if (plugin?.bootstrapFilesGlobPath) {
                    const startedWithSlash = plugin.bootstrapFilesGlobPath.startsWith("/") ? "" : "/";
                    try {
                        await fileLoader(AppDir + "/api/**" + startedWithSlash + plugin.bootstrapFilesGlobPath, true);
                    } catch (error) {
                        console.error(`Plugin ${plugin.name} bootstrapFilesGlobPath error:`, error);
                    }
                }
            }
        }
        if (options?.onInit) {
            try {
                await options.onInit(context);
            } catch (error) {
                console.error(`OnInit error:`, error);
                process.exit(1);
            }
        }

        const apiPrefix = getConfig('API_PREFIX', '/api');
        const appPort = getConfig('PORT', 3000);
        const appName = getConfig('NAME', 'App');
        const appHost = getConfig('HOST', 'localhost');
        const appVersion = getConfig('VERSION', '1.0.0');

        const servicesPath = AppDir + serverOptions.globServicesPath;
        await fileLoader(servicesPath, true);

        loadHelmetModule(app);
        app.use(cors(appOptions.corsOptions));
        app.options('*', cors());

        // Static files
        app.use(
            "/public",
            express.static(path.join(AppDir, "public"), { maxAge: 31557600000 })
        );

        // Home page
        app.get("/", (req, res) => {
            res.json({
                title: appName,
                mode: appOptions.environment,
                date: new Date(),
            });
        });

        // 404 Page
        app.get("/404", function (req, res) {
            res.status(404).send({ status: 404, message: "Page Not Found!" });
        });

        routingControllersUseContainer(Container);
        loadMorganModule(app, logger);

        useExpressServer(app, {
            validation: { stopAtFirstError: true, whitelist: true },
            cors: appOptions.corsOptions,
            classTransformer: true,
            defaultErrorHandler: false,
            routePrefix: apiPrefix,
            controllers: [AppDir + serverOptions.globControllersPath],
            middlewares: [
                AppDir + '/app/middlewares/**/*.middleware.ts',
                AppDir + serverOptions.globMiddlewaresPath
            ],
        });
        await AsyncResolver.resolveAll();
        const server = createServer(app);

        context.server = server;

        if (options?.plugins && options.plugins.length > 0) {
            for (const plugin of options.plugins) {
                if (plugin.beforeStart) {
                    try {
                        await plugin.beforeStart(context);
                    } catch (error) {
                        console.error(`Plugin ${plugin.name} beforeStart error:`, error);
                    }
                }
            }
        }

        if (options?.beforeStart) {
            try {
                await options.beforeStart(context);
            } catch (error) {
                console.error(`BeforeStart error:`, error);
            }
        }

        process.nextTick(async () => {
            const schemas = validationMetadatasToSchemas({
                refPointerPrefix: "#/components/schemas/",
            });

            const storage = getMetadataArgsStorage();

            const defaultInfo = {
                description: `${appName} API Documentation`,
                title: appName,
                version: appVersion,
            };
            let info = defaultInfo;
            if (appOptions.swaggerOptions?.info) {
                if ("function" === typeof appOptions.swaggerOptions.info) {
                    info = appOptions.swaggerOptions.info(defaultInfo);
                } else if ("object" === typeof appOptions.swaggerOptions.info) {
                    info = {
                        ...defaultInfo,
                        ...appOptions.swaggerOptions.info,
                    }
                }
            }
            const spec = routingControllersToSpec(
                storage,
                { routePrefix: apiPrefix },
                {
                    components: {
                        schemas,
                        securitySchemes: appOptions.swaggerOptions?.securitySchemes || {},
                    },

                    info: info,
                }
            );
            const baseDir = appOptions?.swaggerOptions?.baseDir || '/docs';
            app.use(baseDir, swaggerUiExpress.serve, swaggerUiExpress.setup(spec));
            app.use("/docs-json", (req, res) => {
                res.json(spec);
            });

            server.listen(appPort, async () => {
                logger.info(`🚀 Server started at http://${appHost}:${appPort}\n🚨️ Environment: ${appOptions.environment}`);
                logger.info(`Documentation is available at http://${appHost}:${appPort}${baseDir}`);
                if (options?.afterStart) {
                    try {
                        await options.afterStart(context);
                    } catch (error) {
                        console.error(error);
                    }
                }
                if (options?.plugins && options.plugins.length > 0) {
                    for (const plugin of options.plugins) {
                        if (plugin.afterStart) {
                            try {
                                await plugin.afterStart(context);
                            } catch (error) {
                                console.error(error);
                            }
                        }
                    }
                }
            });
            server.on("error", (err: any) => {
                logger.error(err);
            });
        });

    } catch (error) {
        console.error(error);
    }
}

export { AppConfig, AppDir, environment, getConfig, logger, Container };