'use strict';

// Modules
const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');

// Helper for default config
const getDefaultConf = (caDir, instance) => ({
  caCertDir: caDir,
  caCert: path.join(caDir, 'lando.pem'),
  caService: path.join(caDir, 'ca-setup.yml'),
  caProject: 'landocasetupkenobi38ahsoka' + instance,
  networkBridge: 'lando_bridge_network',
});

module.exports = lando => {
  // Define some things
  const id = lando.config.instance;
  const usr = lando.config.userConfRoot;
  // Add some config for our networking
  lando.events.on('post-bootstrap', lando => {
    // Log
    lando.log.info('Configuring networking plugin');
    // Merge defaults over the config, this allows users to set their own things
    lando.config = lando.utils.config.merge(getDefaultConf(path.join(usr, 'certs'), id), lando.config);
    // Log it
    lando.log.verbose('Networking plugin configured with %j', lando.config);
    // Create the cert directory
    fs.mkdirpSync(lando.config.caCertDir);
    // Create a docker compose file to run ca creation
    const caService = {
      version: '3.2',
      services: {
        ca: {
          image: 'devwithlando/util:stable',
          environment: {
            LANDO_CA_CERT: path.basename(lando.config.caCert),
            LANDO_CONFIG_DIR: '$LANDO_ENGINE_CONF',
            LANDO_SERVICE_TYPE: 'ca',
            COLUMNS: 256,
            TERM: 'xterm',
          },
          command: ['tail', '-f', '/dev/null'],
          labels: {
            'io.lando.container': 'TRUE',
            'io.lando.service-container': 'TRUE',
          },
          volumes: [
            '$LANDO_ENGINE_SCRIPTS_DIR/setup-ca.sh:/setup-ca.sh',
            '$LANDO_ENGINE_CONF/certs:/certs',
          ],
        },
      },
    };
    // Log
    lando.log.debug('Creating ca-setup service %j', caService);
    lando.yaml.dump(lando.config.caService, caService);
    // Move our scripts over so we can use them elsewhere
    const scriptFrom = path.join(__dirname, 'scripts');
    const scriptTo = lando.config.engineScriptsDir;
    lando.log.verbose('Copying config from %s to %s', scriptFrom, scriptTo);
    lando.utils.engine.moveConfig(scriptFrom, scriptTo);
    // Ensure scripts are executable
    lando.utils.engine.makeExecutable(['add-cert.sh', 'setup-ca.sh'], lando.config.engineScriptsDir);
  });

  // Preemptively make sure we have enough networks and if we dont
  // smartly prune some of them
  lando.events.on('pre-engine-start', 1, () => {
    // Let's get a list of network
    return lando.engine.getNetworks()

    // If we are at the threshold lets engage some pruning ops
    .then(networks => {
      if (_.size(networks) >= 32) {
        // Warn user about this action
        lando.log.warn('Lando has detected you are at Docker\'s network limit!');
        lando.log.warn('Give us a moment as we try to make space by cleaning up old networks...');
        // List of default networks we can assume
        const landoNets = ['bridge', 'host', 'none', lando.config.networkBridge];
        // Add in proxyNet if we have if
        if (_.has(lando, 'config.proxyNet')) landoNets.push(lando.config.proxyNet);
        // Get list of app default networks
        return lando.app.list()
        // And add them to our default list
        .each(app => {
          landoNets.push(app.lando + '_default');
        })
        // Map some networks
        .then(() => networks)
        // Filter out any landoy ones
        .filter(network => !_.includes(landoNets, network.Name))
        // Inspect remaining networks to make sure we dont remove any
        // with attached containers
        .map(network => lando.engine.getNetwork(network.Id))
        .map(network => network.inspect())
        // Filter out any with containers
        .filter(network => _.isEmpty(network.Containers))
        // Return the oldest 5 unused networks
        // @todo: what is the best assumption here?
        .then(networks => _.slice(_.orderBy(networks, 'Created', 'asc'), 0, 5))
        // Get the Network object
        .map(network => lando.engine.getNetwork(network.Id))
        // and remove it
        .each(net => {
          lando.log.warn('Removing old network %s', net.id);
          net.remove();
        });
      }
    });
  });

  // Make sure we have a lando bridge network
  // We do this here so we can take advantage of docker up assurancs in engine.js
  // and to make sure it covers all non-app services
  lando.events.on('pre-engine-start', 2, () => {
    // Let's get a list of network
    return lando.engine.getNetworks()
    // Try to find our net
    .then(networks => _.some(networks, network => network.Name === lando.config.networkBridge))
    // Create if needed
    .then(exists => {
      if (!exists) {
        return lando.engine.createNetwork(lando.config.networkBridge);
      }
    });
  });

  // Make sure we have a host-exposed root ca if we dont already
  // Also dont run this on the caProject otherwise infinite loop happens!
  lando.events.on('pre-engine-start', 2, data => {
    if (!fs.existsSync(lando.config.caCert) && data.project !== lando.config.caProject) {
      // Define the full CA service
      const ca = {
        id: [lando.config.caProject, 'ca', '1'].join('_'),
        compose: [lando.config.caService],
        project: lando.config.caProject,
        cmd: '/setup-ca.sh',
        opts: {
          mode: 'attach',
          services: ['ca'],
          autoRemove: true,
        },
      };

      // Check if ca setup is already happening
      return lando.engine.list()

      // Filter it out
      .filter(container => container.name === ca.id)

      // Setup the CA
      .then(containers => {
        if (_.isEmpty(containers)) return lando.engine.run(ca);
      });
    }
  });

  // Add all the apps containers to the lando bridge network after the app starts
  // @NOTE: containers are automatically removed when the app stops
  lando.events.on('post-instantiate-app', 1, app => {
    app.events.on('post-start', 1, () => {
      // We assume the lando net exists at this point
      // @todo: is it safe to use a name vs an id here?
      const landonet = lando.engine.getNetwork(lando.config.networkBridge);
      // List all our app containers
      return lando.engine.list(app.name)
      // Go through each container
      .each(container => {
        // Set useful defaults
        const service = container.service;
        let aliases = [[service, container.app, 'internal'].join('.')];

        // Add in any additional aliases if we have proxy settings
        if (_.has(app, 'config.proxy.' + service)) {
          const proxies = _.get(app, 'config.proxy.' + service);
          if (!_.isNil(proxies) && _.isString(proxies[0])) {
            aliases = _.compact(aliases.concat(proxies));
          }
        }

        // Build out our options
        const opts = {Container: container.id, EndpointConfig: {Aliases: aliases}};

        // Sometimes you need to disconnect before you reconnect
        return landonet.disconnect(opts)

        // Only throw non not connected errors
        .catch(error => {
          if (!_.includes(error.message, 'is not connected to network lando')) {
            throw error;
          }
        })

        // Connect
        .then(() => {
          landonet.connect(opts);
          lando.log.info('Connected %s to the landonet', container.name);
        });
      });
    });
  });

  // Add the hostname to the info
  lando.events.on('post-instantiate-app', app => {
    app.events.on('post-info', () => {
      _.forEach(app.info, (data, name) => {
        data.hostnames = _.get(data, 'hostnames', []);
        data.hostnames.push([name, app.name, 'internal'].join('.'));
      });
    });
  });
};
