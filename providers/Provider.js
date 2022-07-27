const path = require('path')
const newrelic = require('newrelic')

const { resolver, ServiceProvider } = require('@adonisjs/fold')
const { intersection } = require('lodash')

function hasMethod (obj, name) {
  const descriptor = Object.getOwnPropertyDescriptor(obj, name)
  return !!descriptor && typeof descriptor.value === 'function'
}

function getInstanceMethods (obj, stop) {
  const array = []
  let prototype = Object.getPrototypeOf(obj)
  while (prototype && prototype !== stop) {
    Object.getOwnPropertyNames(prototype).forEach(name => {
      if (name !== 'constructor' && hasMethod(prototype, name)) {
        array.push(name)
      }
    })

    prototype = Object.getPrototypeOf(prototype)
  }
  return array
}

class NewRelicProvider extends ServiceProvider {
  register () {
    this.app.singleton('NewRelic', () => {
      return newrelic
    })
  }

  boot () {
    const Helpers = this.app.use('Helpers')

    if (Helpers.isAceCommand()) {
      return
    }

    const Logger = this.app.use('Logger')
    const Route = this.app.use('Route')
    const newrelic = this.app.use('NewRelic')

    const appRoot = Helpers.appRoot()

    const newRelicPackage = require(path.join(
      appRoot,
      'node_modules/newrelic/package.json'
    ))
    const _this = this

    Logger.info(`loading ${newRelicPackage.name} v${newRelicPackage.version}`)

    /* The module name has to match the actual require call in the register() method for AdonisJS
     * framework provider due to the way NewRelic hijacks require calls in Node.js. This particular
     * module name: '../src/Server/` matches the call in:
     * https://github.com/adonisjs/adonis-framework/blob/a4998b4978a78455d29cd1cd3b75c75ba9973dd3/providers/AppProvider.js#L148
     */
    newrelic.instrumentWebframework(
      '../src/Server',
      function (shim, Server) {
        shim.setFramework('AdonisJs')

        // Wrap the global handle function.
        shim.wrap(Server.prototype, 'handle', function (shim, originalFn) {
          return function (req, res) {
            const args = shim.argsToArray.apply(shim, arguments)
            const ctx = new this.Context(req, res)
            const { request } = ctx
            const excludeVerbs = ['OPTIONS', 'TRACE']

            // We can't match a route for OPTIONS or TRACE request.
            if (!excludeVerbs.includes(request.method())) {
              if (!this.Route) {
                return originalFn.apply(this, args)
              }

              const match = this.Route.match(
                request.url(),
                request.method(),
                request.hostname()
              )

              if (!match) {
                return originalFn.apply(this, args)
              }

              const { name: routeName, handler } = match.route.toJSON()

              if (shim.isString(handler)) {
                const [controller, action] = handler.split('.')
                newrelic.setControllerName(controller, action)
              } else if (shim.isFunction(handler)) {
                newrelic.setControllerName(routeName, request.method())
              }
            }

            /* Wrap Route's match method. This has to be done here because we still need the raw
             * request object.
             */
            shim.recordMiddleware(this.Route.match, {
              type: shim.ROUTER,
              route: request.url(),
              req () {
                return req
              },
              res () {
                return res
              }
            })

            // Scope of `this` is the Server instance.
            return originalFn.apply(this, args)
          }
        })

        /* Wrap the route method. This will automatically handle get, post, put, patch, and delete
         * methods in the RouteManager instance since they're just aliases to the route method.
         */
        shim.wrap(Route, 'route', function (shim, originalFn) {
          return function (route, handler, verbs) {
            const wrappedHandler = _this.wrapRoute(shim, route, handler, verbs)

            // Scope of `this` is the RouteManager instance.
            return originalFn.apply(this, [route, wrappedHandler, verbs])
          }
        })

        /* We need to wrap route resource separately due to the way resources get set up by the route
         * manager.
         */
        shim.wrap(Route, 'resource', function (shim, originalFn) {
          return function (resource, controllerName) {
            const args = shim.argsToArray.apply(shim, arguments)
            _this.wrapResource(shim, resource, controllerName)

            // Scope of `this` is the RouteManager instance.
            return originalFn.apply(this, args)
          }
        })

        // Wrap middleware mounter functions.
        shim.wrap(
          Server.prototype,
          ['registerGlobal', 'registerNamed', 'use'],
          function (shim, originalFn) {
            return function (middleware) {
              const args = shim.argsToArray.apply(shim, arguments)

              if (shim.isArray(middleware)) {
                _this.wrapMiddleware(shim, middleware)
              } else if (shim.isObject(middleware)) {
                _this.wrapMiddleware(shim, Object.values(middleware))
              }

              // Scope of `this` is the Server instance.
              return originalFn.apply(this, args)
            }
          }
        )
      },
      function (err) {
        Logger.error(err)
      }
    )
  }

  /**
   * Wraps a route handler.
   * @param {Shim} shim
   * @param {String} route
   * @param {String|Function} handler
   */
  wrapRoute (shim, route, handler) {
    // The handler is a function
    if (shim.isFunction(handler)) {
      return shim.recordMiddleware(handler, {
        type: shim.APPLICATION,
        name: '<anonymous_function>',
        route,
        req (shim, fn, fnName, args) {
          return args[0].req
        },
        res (shim, fn, fnName, args) {
          return args[0].res
        },
        next: shim.SECOND,
        params (shim, fn, fnName, args) {
          return args[0].params
        }
      })
    } else if (shim.isString(handler)) {
      const [controllerName, action] = handler.split('.')
      const controllerInstance = resolver
        .forDir('httpControllers')
        .resolve(controllerName)
      const fn = controllerInstance[action]
      controllerInstance[action] = this.wrapControllerMethod(
        shim,
        controllerName,
        action,
        fn
      )
      const controllerNamespace = resolver
        .forDir('httpControllers')
        .translate(controllerName)
      this.app.bind(controllerNamespace, () => controllerInstance)
      return handler
    }

    throw new TypeError('Route handler must be a string or function.')
  }

  /**
   * Wrap route resource.
   * @param {Shim} shim
   * @param {String} resource
   * @param {String} controllerName
   */
  wrapResource (shim, resource, controllerName) {
    const resourceMethods = [
      'index',
      'create',
      'store',
      'show',
      'edit',
      'update',
      'destroy'
    ]
    const controllerInstance = resolver
      .forDir('httpControllers')
      .resolve(controllerName)
    const controllerMethods = getInstanceMethods(controllerInstance)
    const wrappableMethods = intersection(resourceMethods, controllerMethods)

    wrappableMethods.forEach(method => {
      const fn = controllerInstance[method]
      controllerInstance[method] = this.wrapControllerMethod(
        shim,
        controllerName,
        method,
        fn
      )
    })

    const controllerNamespace = resolver
      .forDir('httpControllers')
      .translate(controllerName)
    this.app.bind(controllerNamespace, () => controllerInstance)
  }

  /**
   * Creates a wrapper around the given controller method.
   * @param {Shim} shim
   * @param {String} controllerName
   * @param {String} fnName
   * @param {Function} originalFn
   */
  wrapControllerMethod (shim, controllerName, fnName, originalFn) {
    return function ({ request }) {
      const args = shim.argsToArray.apply(shim, arguments)
      const name = `${controllerName}.${fnName}`
      const spec = {
        type: shim.APPLICATION,
        name,
        route: request.url(),
        req (shim, fn, fnName, args) {
          return args[0].req
        },
        res (shim, fn, fnName, args) {
          return args[0].res
        },
        next: shim.SECOND,
        params (shim, fn, fnName, args) {
          return args[0].params
        },
        promise: true
      }
      return shim.recordMiddleware(originalFn, spec).apply(this, args)
    }
  }

  /**
   * Wraps the handle method of given array of middleware.
   * @param {Shim} shim
   * @param {String[]} middleware
   */
  wrapMiddleware (shim, middleware) {
    const iocBindings = this.app.getBindings()

    middleware.forEach(namespace => {
      const binding = iocBindings[namespace]

      if (binding) {
        const middleware = binding.singleton
          ? binding.cacheValue || binding.closure(this.app)
          : binding.closure(this.app)
        const handleFn = middleware.handle
        middleware.handle = this.wrapMiddlewareHandler(
          shim,
          namespace,
          handleFn
        )

        // Re-bind the middleware with wrapped handle function
        if (binding.singleton) {
          this.app.singleton(namespace, () => middleware)
        } else {
          this.app.bind(namespace, () => middleware)
        }

        return
      }

      /* If binding doesn’t already exist, we’re probably dealing with application middleware (e.g.
       * App/Middleware/AppSpecificMiddleware). If this is the case, it’s covered under the Ioc
       * autoloading but it will return a class and not an instance. So we’ll need to modify the
       * prototype to wrap the instance method and actually bind the instance.
       */
      const Middleware = this.app.use(namespace)
      const handleFn = Middleware.prototype.handle
      Middleware.prototype.handle = this.wrapMiddlewareHandler(
        shim,
        namespace,
        handleFn
      )
      this.app.bind(namespace, () => new Middleware())
    })
  }

  /**
   * Returns a new handler function that wraps the original middleware handle method with New Relic
   * instrumentation logic.
   * @param {Shim} shim
   * @param {String} namespace IoC namespace for the middleware
   * @param {Function} handleFn reference to middleware's handle method
   */
  wrapMiddlewareHandler (shim, namespace, handleFn) {
    const middlewareName = namespace.split('/').slice(-1)[0]

    // This function is what will actually replace the middleware’s handle function.
    return function ({ request }) {
      const args = shim.argsToArray.apply(shim, arguments)
      const spec = {
        type: shim.MIDDLEWARE,
        name: `${middlewareName}.handle`,
        route: request.url(),
        req (shim, fn, fnName, args) {
          return args[0].req
        },
        res (shim, fn, fnName, args) {
          return args[0].res
        },
        params (shim, fn, fnName, args) {
          return args[0].params
        },
        next: shim.SECOND,
        promise: true
      }
      return shim.recordMiddleware(handleFn, spec).apply(this, args)
    }
  }
}

module.exports = NewRelicProvider
