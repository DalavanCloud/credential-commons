const _ = require('lodash');
const timestamp = require('unix-timestamp');
const sjcl = require('sjcl');
const SecureRandom = require('../SecureRandom');
const definitions = require('./definitions');

const validIdentifiers = _.map(definitions, d => d.identifier);

/**
 * validate the value type
 * @param {*} value
 * @param {*} type
 */
function isValueOfType(value, type) {
  switch (type) {
    case 'String':
      return _.isString(value);
    case 'Number':
      return _.isNumber(value);
    case 'Boolean':
      return _.isBoolean(value);
    default:
      return false;
  }
}

function isValid(value, type, definition) {
  switch (type) {
    case 'String':
      return (definition.pattern ? definition.pattern.test(value) : true) &&
        (definition.minimumLength ? value.length >= definition.minimumLength : true) &&
        (definition.maximumLength ? value.length <= definition.minimumLength : true);
    case 'Number':
      return ((!_.isNil(definition.minimum) &&
        definition.exclusiveMinimum ? value > definition.minimum : value >= definition.minimum) || _.isNil(definition.minimum)) &&
        ((!_.isNil(definition.maximum) &&
        definition.exclusiveMaximum ? value < definition.maximum : value <= definition.maximum) || _.isNil(definition.maximum));
    case 'Boolean':
      return _.isBoolean(value);
    default:
      return false;
  }
}

/**
 * extract the expected Type name for the value when constructin an UCA
 * @param {*} definition
 */
const getTypeName = (definition) => {
  if (_.isString(definition.type)) {
    if (_.includes(validIdentifiers, definition.type)) {
      const innerDefinition = _.find(definitions, { identifier: definition.type });
      return getTypeName(innerDefinition);
    }

    return definition.type;
  }
  return 'Object';
};

const resolveType = (definition) => {
  const typeName = getTypeName(definition);
  if (!(typeName === 'Object')) {
    return typeName;
  }

  if (!_.isString(definition.type)) {
    return definition.type;
  }

  const refDefinition = _.find(definitions, { identifier: definition.type });
  return resolveType(refDefinition);
};

const isAttestableValue = value => (
  value && value.attestableValue
);

const parseAttestableValue = (value) => {
  const values = [];
  const splitPipes = _.split(value.attestableValue, '|');
  const attestableValueRegex = /^urn:(\w*):(\w*):([\w|\W]*)/;
  _.each(splitPipes, (stringValue) => {
    const match = attestableValueRegex.exec(stringValue);
    if (match && match.length === 4) {
      const v = {
        propertyName: match[1],
        salt: match[2],
        value: match[3],
        stringValue,
      };
      values.push(v);
    }
  });
  if (splitPipes.length !== values.length && splitPipes.length !== values.length + 1) {
    throw new Error('Invalid attestableValue');
  }
  return values;
};

/**
 * Creates new UCA instances
 * @param {*} identifier
 * @param {*} value
 */
function UCABaseConstructor(identifier, value, version) {
  this.timestamp = null;
  this.id = null;

  if (!_.includes(validIdentifiers, identifier)) {
    throw new Error(`${identifier} is not defined`);
  }


  this.identifier = identifier;
  const definition = version ? _.find(definitions, { identifier, version }) : _.find(definitions, { identifier });
  this.version = version || definition.version;

  this.type = getTypeName(definition);

  definition.type = resolveType(definition);
  if (isAttestableValue(value)) {
    // Trying to construct UCA with a existing attestableValue
    const parsedAttestableValue = parseAttestableValue(value);
    if (parsedAttestableValue.length === 1) {
      // This is a simple attestableValue
      this.timestamp = null;
      this.salt = parsedAttestableValue[0].salt;
      this.value = parsedAttestableValue[0].value;
    } else {
      const ucaValue = {};
      for (let i = 0; i < parsedAttestableValue.length; i += 1) {
        const propertyName = parsedAttestableValue[i].propertyName;
        // we have stored only the property name on the urn, so we have to find the UCA definition
        const filteredIdentifier = definition.type.properties.find(property => property.type.endsWith(propertyName)).type;
        ucaValue[propertyName] = new UCABaseConstructor(filteredIdentifier, { attestableValue: parsedAttestableValue[i].stringValue });
      }
      // console.log(ucaValue);
      this.value = ucaValue;
    }
  } else if (isValueOfType(value, this.type)) {
    // Trying to construct UCA with a normal value
    this.timestamp = timestamp.now();
    if (!isValid(value, this.type, definition)) {
      throw new Error(`${JSON.stringify(value)} is not valid for ${identifier}`);
    }
    this.value = value;
    this.salt = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(SecureRandom.wordWith(64)));
  } else if (_.isEmpty(definition.type.properties)) {
    throw new Error(`${JSON.stringify(value)} is not valid for ${identifier}`);
  } else {
    const hasRequireds = _.reduce(definition.type.required, (has, required) => value[required] && has, true);
    if (!hasRequireds) {
      throw new Error(`Missing required fields to ${identifier}`);
    }
    const ucaValue = _.mapValues(_.keyBy(_.map(value, (v, k) => {
      const propertyDef = _.find(definition.type.properties, { name: k });
      const uca = new UCABaseConstructor(propertyDef.type, v, propertyDef.version);
      return { key: k, value: uca };
    }), 'key'), 'value');
    this.value = ucaValue;
  }

  this.getAttestableValue = () => {
    // all UCA properties they have the form of :propertyName or :something.propertyName
    const startIndexForPropertyName = this.identifier.includes('.') ? this.identifier.lastIndexOf('.') : this.identifier.lastIndexOf(':');
    const propertyName = this.identifier.substring(startIndexForPropertyName + 1);
    // it was defined that the attestable value would be on the URN type https://tools.ietf.org/html/rfc8141
    switch (this.type) {
      case 'String':
        return `urn:${propertyName}:${this.salt}:${this.value}`;
      case 'Number':
        return `urn:${propertyName}:${this.salt}:${_.padStart(this.value.toString(), 8, '0')}`; // TODO @jpsantosbh why did you pad this value?
      case 'Boolean':
        return `urn:${propertyName}:${this.salt}:${this.value}`;
      default:
        return _.reduce(_.sortBy(_.keys(this.value)), (s, k) => `${s}${this.value[k].getAttestableValue()}|`, '');
    }
  };

  /**
   * Returns the global CredentialItemIdentifier of the Credential
   */
  this.getGlobalCredentialItemIdentifier = () => (`uca-${this.identifier}-${this.version}`);

  this.getClaimRootPropertyName = () => {
    const identifierComponentes = _.split(this.identifier, ':');
    return _.lowerCase(identifierComponentes[1]);
  };

  this.getClaimPropertyName = () => {
    const identifierComponentes = _.split(this.identifier, ':');
    return identifierComponentes[2];
  };

  this.getClaimPath = () => {
    const identifierComponentes = _.split(this.identifier, ':');
    const baseName = _.lowerCase(identifierComponentes[1]);
    return `${baseName}.${identifierComponentes[2]}`;
  };

  this.getAttestableValues = () => {
    const values = [];
    const def = _.find(definitions, { identifier: this.identifier, version: this.version });
    if (def.credentialItem || def.attestable) {
      values.push({ identifier: this.identifier, value: this.getAttestableValue() });
      if (this.type === 'Object') {
        _.forEach(_.keys(this.value), (k) => {
          const innerValues = this.value[k].getAttestableValues();
          _.reduce(innerValues, (res, iv) => res.push(iv), values);
        });
      }
    }
    return values;
  };

  this.getPlainValue = (propName) => {
    const newParent = {};
    const result = [];
    switch (this.type) {
      case 'String':
      case 'Number':
      case 'Boolean':
        if (propName) {
          newParent[propName] = this.value;
        } else {
          if (!this.credentialItem) {
            return this.value;
          }
          newParent[this.identifier] = this.value;
        }
        return newParent;
      default:

        _.forEach(_.sortBy(_.keys(this.value)), (k) => {
          result.push(this.value[k].getPlainValue(k));
        });
        _.forEach(result, (properties) => {
          _.assign(newParent, properties);
        });
        return newParent;
    }
  };

  const hash = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(this.getAttestableValue()));
  this.id = `${this.version}:${this.identifier}:${hash}`;

  return this;
}

const UCA = UCABaseConstructor;

function convertIdentifierToClassName(identifier) {
  const identifierComponentes = _.split(identifier, ':');
  const baseName = identifierComponentes[1];
  const detailName = _.upperFirst(_.camelCase(identifierComponentes[2]));
  return `${baseName}${detailName}`;
}

// Extend UCA Semantic
_.forEach(_.filter(definitions, d => d.credentialItem), (def) => {
  const name = convertIdentifierToClassName(def.identifier);
  const source = {};
  const identifier = def.identifier;

  function UCAConstructor(value, version) {
    const self = new UCABaseConstructor(identifier, value, version);
    return self;
  }
  source[name] = UCAConstructor;
  _.mixin(UCA, source);
});

UCA.getTypeName = getTypeName;
UCA.resolveType = resolveType;

module.exports = UCA;
