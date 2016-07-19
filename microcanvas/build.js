 'use strict';

const fs = require('fs');
const acorn = require('acorn');

let srcFile = process.argv[2] || '../templates/sprites/sprites.js';
let targetSystem = process.argv[3] || 'arduboy';

// Button mapping for different targets
const BUTTONS = {
  'arduboy': {
    left: 'LEFT_BUTTON',
    right: 'RIGHT_BUTTON',
    up: 'UP_BUTTON',
    down: 'DOWN_BUTTON',
    space: 'A_BUTTON',
    enter: 'B_BUTTON',
  }
}

let src = fs.readFileSync(srcFile);

let ast = acorn.parse(src ,{ ecmaVersion: 6, sourceType: 'script' });

fs.writeFileSync('ast.json', JSON.stringify(ast));


// Init
let game = {
  alias: 'game',
  target: targetSystem,
  constants: [], globals: [], gfx: [], sfx: []
};


// Parse
parseGlobals(); // TODO: function declarations!

parseInitializers();

parseSetupBody();

parseLoopBody();

// Build
game.ino = exportGame(targetSystem);

// Save
fs.writeFileSync('game.json', JSON.stringify(game));

fs.writeFileSync('game.ino', game.ino||'');



function createConstant(id, value, type) {
  // If no type specified, try to guess it
  // PS: constants shouldn't be affected by scope issues
  //if (!type) type = guessType(id, value, 'constant');
  // only explicit types here, do not guess here only on output

  game.constants.push({
    id: id,
    cid: toConstCase(id),
    value: value,
    type: type
  });

  // Make the constant accessible via its id
  game.constants[id] = game.constants[game.constants.length-1];

  console.log('+ new const: %s = %s', game.constants[id].cid, value);
}

// Collect global declarations
function parseGlobals() {
  console.log('Processing globals');

  // TODO: check for reserved globals, like "arduboy"

  let vars = ast.body
  .filter(o => o.type === 'VariableDeclaration')
  .forEach(function (n) {
    if (n.kind === 'const') {
      n.declarations.forEach(dec => {
        createConstant(getString(dec.id), getString(dec.init));
      });

    } else if (n.kind === 'let') {
      n.declarations.forEach(dec => {
        if (dec.id.name.match(/^gfx/)) {
          game.gfx.push({
            id: dec.id.name,
            cid: toSnakeCase(dec.id.name)
          });
          game.gfx[dec.id.name] = game.gfx[game.gfx.length-1];

        } else if (dec.id.name.match(/^sfx/)) {
          game.sfx.push({
            id: dec.id.name,
            cid: toSnakeCase(dec.id.name)
          });
          game.sfx[dec.id.name] = game.sfx[game.sfx.length-1];

        // MicroCanvas standard library hook
        } else if (getString(dec.init) === 'new MicroCanvas') {
          game.alias = dec.id.name;

          console.log("MicroCanvas uses the alias: game")

        } else {
          game.globals.push({
            id: dec.id.name,
            cid: toSnakeCase(dec.id.name),
            value: dec.init ? dec.init.value : void 0
          });
          game.globals[dec.id.name] = game.globals[game.globals.length-1];
        }
      });
    }
  });
}

// Find intializers
function parseInitializers() {
  console.log('Looking for initializers');

  let initializers = ast.body
    .filter(o => o.type === 'ExpressionStatement')
    .map(es => es.expression)
    .filter(ex => ex.type === 'CallExpression' && ex.callee.type === 'MemberExpression' && ex.callee.object.name === game.alias)

  if (!initializers) {
    throw new Error('Invalid MicroCanvas file: initializers (setup/loop) not found.');
  }

  game.initializers = {
    setup: initializers.find(e => e.callee.property.name === 'setup'),
    loop: initializers.find(e => e.callee.property.name === 'loop')
  };

  if (!game.initializers.setup) {
    throw new Error('Required initializer `game.setup()` not found.');
  }
  if (!game.initializers.loop) {
    throw new Error('Required initializer `game.loop()` not found.');
  }
}

// Parse game.setup call body and generate setup
function parseSetupBody() {
  console.log('Processing game.setup()');
  game.setup = { code: [] };

  let sbody = game.initializers.setup
    .arguments[0] // FunctionExpression; TODO: reference
    .body // BlockStatement
    .body;

  // Walk the setup-body contents
  sbody.forEach(exp => {
    // Load graphics or sound assets
    if (exp.expression
     && exp.expression.type === 'AssignmentExpression'
     && exp.expression.left.type === 'Identifier' // TODO: MemberExpression, like game.state
     && exp.expression.left.name.match(/^(gfx|sfx)/)
    ) {
      loadAsset(exp.expression);

    // Try translating the line
    } else if (true) {
      let ln = translate(exp);
      game.setup.code.push(ln);
      console.log('>>> '+ln);

    } else {
      console.log('Unknown expression: '+getString(exp));
    }
  });
}

// Parse game.setup call body and generate setup
function parseLoopBody() {
  console.log('Processing game.loop()');
  game.loop = { code: [] };

  let loopbody = game.initializers.loop
    .arguments[0] // FunctionExpression; TODO: reference
    .body // BlockStatement
    .body;

  // Walk the setup-body contents
  loopbody.forEach(exp => {
    let ln = translate(exp);
    game.loop.code.push(ln);
    console.log('>>> '+ln);
  });
}


function toSnakeCase(s) {
  return s.replace(/[A-Z0-9]/g, e => '_'+e.toLowerCase() );
}

function toConstCase(s) {
  // Already in const case
  if (s.match(/^[A-Z0-9_]+$/)) return s;

  return toSnakeCase(s).toUpperCase();
}

function isCalling(exp, id) {
  if (exp.type === 'CallExpression') {
    // looking for a MemberExpression
    if (id.indexOf('.')) {
      let mexp = id.split('.');
      if (exp.callee.type === 'MemberExpression') {
        return (
          exp.callee.object.name === mexp[0]
          &&
          exp.callee.property.name === mexp[1]
        );
      } else {
        console.warn('Expecting call to a MemberExpression `'+id+'(…)`, but found: '+exp.right.type);
      }

    // Other call
    } else {
      console.warn('Unrecognized call expression format: '+id);
    }
  } else {
    console.warn('Expecting CallExpression `'+id+'(…)`, but found: '+exp.type);
  }

  return false;
}

function getString(exp) {
  if (typeof exp === 'string') return exp;

  if (!exp || !exp.type ) return '?';

  let self = getString;

  switch (exp.type) {
    case 'Identifier':
      return exp.name;

    case 'Literal':
      return exp.value;

    case 'TemplateLiteral':
      return (exp.quasis.map(q => q.value.raw).join())

    case 'MemberExpression':
      // Simple property access
      if (exp.property.type === 'Identifier') {
        return (self(exp.object) + '.' + self(exp.property));
      }

      // Property expression
      return (self(exp.object) + '[ ' + self(exp.property)) +' ]';

    case 'NewExpression':
      return 'new '+self(exp.callee);

    case 'ExpressionStatement':
      return self(exp.expression);

    case 'BinaryExpression':
    case 'AssignmentExpression':
      return self(exp.left) +' '+exp.operator+' '+ self(exp.right);

    default:
      return '? '+exp.type;
  }
}

function translate(exp) {
  if (typeof exp === 'string') return exp;

  if (!exp || !exp.type ) return '?';

  let self = translate;

  switch (exp.type) {

    // Literals return the textual definiton of the literal
    case 'Literal':
      return JSON.stringify(exp.value);

    // Look up identifiers
    case 'Identifier': // TODO: we'll need to handle scope (path)
      return lookup(exp);

    // Member expressions are usually translated to built-in methods
    case 'MemberExpression':
      let obj = getString(exp.object);

      // MicroCanvas calls
      if (obj === game.alias
       || obj.match(/^(g|s)fx/) // Game asset properties (gfx & sfx)
     ) {
        return translateLib(exp);

      // Some other library
      } else {
        // Simple property access
        if (exp.property.type === 'Identifier') {
          return '? ' + (self(exp.object) + '.' + self(exp.property));
        }

        // Property expression
        return '? ' + (self(exp.object) + '[ ' + self(exp.property)) +' ]';
      }

    // Just unwrap expression body
    case 'ExpressionStatement':
      return self(exp.expression) +';';

    // And wrap a block statement
    case 'BlockStatement':
      return '{\n'+exp.body.map(e => '  '+self(e)).join('\n') +'\n}';

    // If statements are all the same
    case 'IfStatement':
      return 'if ('+self(exp.test)+') '
        +( exp.consequent
           ? self(exp.consequent) + ( exp.alternate ? self(exp.alternate) : '')
           : ''
        );

    // Function calls
    case 'CallExpression':
      return translateLib(exp.callee, exp);

    // Assignment and binary expressions work pretty much unchanged across JS/C
    case 'LogicalExpression': // TODO: parens?
    case 'BinaryExpression':
    case 'AssignmentExpression':
      return self(exp.left) +' '+exp.operator+' '+ self(exp.right);

    // Unary expression (pre + postfix) work mostly the same
    // TODO: boolean tricks? (!something >>> 1-something)
    case 'UnaryExpression':
      return (exp.prefix
        ? exp.operator + self(exp.argument)
        : self(exp.argument) + exp.operator
      );

    default:
      return '? '+exp.type;
  }
}

function translateArgs(args) {
  return '('
    +(args.length
      ? ' '+args.map(arg => translate(arg)).join(', ')+' '
      : ''
    )
  +')';

}

function translateLib(exp, callexp) {
  let obj = getString(exp.object),
      prop = exp.property.type == 'Identifier' ? getString(exp.property) : exp.property;

  if (typeof prop == 'string') console.log('{%s.%s}', obj, prop); else console.log('{%s[%s]}', obj, getString(prop));

  // Standard library (MicroCanvas) method/property
  if (obj === game.alias) {
    switch (prop) {
      // Screen width and height
      case 'width': return 'WIDTH';
      case 'height': return 'HEIGHT';

      // Global game state
      case 'state': return '_microcanvas_state';
    }

    // Function/library method calls
    if (callexp) {
      // Call to 1:1 library mapping library functions
      if (~[
        'everyXFrames',
        'clear',
      ].indexOf(prop)) {
        return game.target+'.'+prop + translateArgs(callexp.arguments);
      }

      // strings in "buttonPressed" are turned into constants
      if (prop === 'buttonPressed') {
        // First argument is the queried button
        let btn = getString(callexp.arguments[0]);

        if (btn in BUTTONS[targetSystem]) {
          return game.target+'.pressed' + translateArgs([ BUTTONS[targetSystem][btn] ]);
        } else {
          return new Error('Unknown button reference: '+btn);
        }
      }

      // drawImage has a different library name and uses different args
      // game.drawImage(gfx,x,y);    >>>    arduboy.drawBitmap(x,y, gfx, GFX_WIDTH,GFX_HEIGHT, WHITE);
      // game.clearImage(gfx,x,y);   >>>    arduboy.drawBitmap(x,y, gfx, GFX_WIDTH,GFX_HEIGHT, BLACK);
      if (prop === 'drawImage' || prop === 'clearImage' || prop === 'eraseImage') {
        let sA = callexp.arguments;
        let gfx = getString(sA[0].object);
        let clear = (prop === 'clearImage' || prop === 'eraseImage');
        let targetArgs = [
          sA[1], sA[2], sA[0],
          { type: 'MemberExpression', object: { type: 'Identifier', name: gfx }, property: { type: 'Identifier', name:'width' }},
          { type: 'MemberExpression', object: { type: 'Identifier', name: gfx }, property: { type: 'Identifier', name: 'height' }},
          clear ? 'BLACK' : 'WHITE'
        ];

        return game.target+'.drawBitmap' + translateArgs(targetArgs);
        // todo subframe slice version
      }

      // drawText
      // sprintf(_microcanvas_textbuffer, "DIST: %d", d);
      // arduboy.setTextSize(3);
      // arduboy.setCursor(0,0);
      // arduboy.print("Sprite\nDemo");
      // game.drawText("Sprite\nDemo", 0,0, 3);
      if (prop === 'drawText') {
        let sA = callexp.arguments;
        // TODO: proper string/concat/cast/etc expression handling
        let text = getString(sA[0]);

        return (
          ( sA[3] ? game.target+'.setTextSize'+translateArgs([ sA[3] ])+';\n' : '')+
          game.target+'.setCursor'+translateArgs([ sA[1], sA[2] ])+';\n'+
          game.target+'.print'+translateArgs([ sA[0] ])
        );// todo subframe slice version
      }

    }

  // Graphics asset property
  } else if (obj.match(/^gfx/)) {
    switch (prop) {
      case 'width':
      case 'height':
      case 'frames':
        let id = obj + prop[0].toUpperCase() + prop.slice(1);
        if (id in game.constants) {
          return game.constants[id].cid;
        }
    }

    // Computed property (e.g. frame access)
    if (typeof prop == 'object') {
      // TODO: proper type checking
      return lookup(obj) + ' + ' + lookup(obj+'Framesize')+'*('+translate(prop)+')';
    }
  }

  return '<'+getString(exp)+'>';
}

function lookup(exp) {
  let id = getString(exp);

  console.log('{%s}', id);

  // It's a global constant
  if (id in game.constants) {
    return game.constants[id].cid;
  }

  // It's a global variable
  if (id in game.globals) {
    return game.globals[id].cid;
  }

  // It's an asset
  if (id in game.gfx) {
    return game.gfx[id].cid;
  }
  if (id in game.sfx) {
    return game.sfx[id].cid;
  }

  // It's a built-in library global or constant
  if (id.match(/^(TRUE|FALSE|WIDTH|HEIGHT|WHITE|BLACK|INVERT)$/)) {
    return id;
  }

  return '%'+id+'%';
}

function loadAsset(exp) {
  let id = exp.left.name;

  // Graphics assets
  if (id.match(/^gfx/)) {
    if (!id in game.gfx) {
      console.warn('Warning: asset '+exp.left.name+' is not declared on the global scope!');
    }

    // LoadGraphics / LoadSprite are both valid methods for loading graphics assets
    if (isCalling(exp.right, game.alias+'.loadGraphics')
     || isCalling(exp.right, game.alias+'.loadSprite')
    ) {
      loadGraphics(id, exp.right.arguments);
      console.log(' 👾 loaded %s as GFX', id);
    } else {
      console.log('Unknown GFX load format: '+JSON.stringify(exp.right.callee));
    }
  }

  if (id.match(/^sfx/)) {
    if (!id in game.sfx) {
      console.warn('Warning: asset '+exp.left.name+' is not declared on the global scope!');
    }

    if (isCalling(exp.right, game.alias+'.loadTune')) {
      loadTune(id, exp.right.arguments);
      console.log(' 🔔 loaded %s as SFX', id);
    } else {
      console.log('Unknown SFX load format: '+getString(exp.right.callee));
    }
  }
}

function loadGraphics(id, args) {
  let str = getString(args[0]);

  // Load graphics data
  game.gfx[id].value = arrayInitializerContent(str);

  // Parse hints and create constants for them
  game.gfx[id].meta = arrayInitializerHints(game.gfx[id].value);

  createConstant(id+'Width', game.gfx[id].meta.w);
  createConstant(id+'Height', game.gfx[id].meta.h);
  createConstant(id+'Frames', game.gfx[id].meta.frames);
  createConstant(id+'Framesize', Math.ceil(game.gfx[id].meta.h/8)*game.gfx[id].meta.w);
};

function loadTune(id, args) {
  let str = getString(args[0]);
  game.sfx[id].value = arrayInitializerContent(str);
};


function arrayInitializerContent(statement) {
  try {
    return ( statement
      .replace(/\r|\n|\t/g, ' ') // remove line breaks and tabs
      .match(/=\s*[{\[](.*)[}\]]/)[1] // match core data
      .replace(/\s+/g, ' ').trim() // clean up whitespace
    ) || statement;
  } catch(e) {};

  return statement;
}

function arrayInitializerHints(statement) {
  let ret = {};

  let m = statement.match(/(?:\/\/|\/\*)\s*(\d+)x(\d+)(?:x(\d+))?/);

  if (m && m[1] && m[2]) {
    ret.w = parseInt(m[1],10);
    ret.h = parseInt(m[2],10);
    ret.frames = m[3] ? parseInt(m[3],10) : 0;
  }

  return ret;
}

function guessType(id, value, hint) {
  if (hint === 'constant' && typeof value == 'number' && value < 256) return 'byte';

  // unsigned int, byte, char, char[]
  return 'int';
}

function exportGame() {
  switch (game.target) {
    case 'arduboy':
      let b = '';

      // Header
      b += arduboyHeader().trim()+'\n\n';

      // Assets
      // Graphics
      if (game.gfx) {
      game.gfx.forEach(asset => {
          b += arduboyGfx(asset.cid, asset.value);
        });
        b+='\n';
      }

      // Sounds
      if (game.sfx) {
        game.sfx.forEach(asset => {
          b += arduboySfx(asset.cid, asset.value);
        });
        b+='\n';
      }

      // Constants
      if (game.constants) {
        game.constants.forEach(c => {
          b += 'const ' + (c.type ? c.type : guessType(c.id, c.value, 'constant')) + ' ';
          b += c.cid;

          if (typeof c.value !== 'undefined') {
            b += ' = ' + c.value;
          }

          b+=';\n';
        });
        b+='\n';
      }

      // Globals
      if (game.globals) {
        game.globals.forEach(c => {
          b += (c.type ? c.type : guessType(c.id, c.value)) + ' ';
          b += c.cid;

          if (typeof c.value !== 'undefined') {
            b += ' = ' + c.value;
          }

          b+=';\n';
        });
        b+='\n';
      }

      // Setup
      b+=arduboySetup(game.setup.code.join('\n'))+'\n';

      // Loop
      b+=arduboyLoop(game.loop.code.join('\n'))+'\n';

      // Functions

      return b;
  }
};

function arduboyHeader() {
  return `
#include <SPI.h>
#include "Arduboy.h"

#include <EEPROM.h>
#include <avr/pgmspace.h>

Arduboy arduboy;

// frame counter, 2-byte unsigned int, max 65536
unsigned int _microcanvas_frame_counter = 0;

// sprintf() textbuffer for drawText
char _microcanvas_textbuffer[32];

// global state machine
unsigned int _microcanvas_state;
`;
}

function arduboyGfx(id, data) {
  return `
PROGMEM const unsigned char ${id}[] = { ${data} };
`;
}

function arduboySfx(id, data) {
  return `
const byte PROGMEM ${id}[] = { ${data} };
`;
}

function arduboySetup(contents) {
  return `
void setup() {
  arduboy.begin();

////// CUSTOM SETUP //////
${contents}
}
`;
}

function arduboyLoop(contents) {
  return `
void loop() {
  ++_microcanvas_frame_counter;
  if (_microcanvas_frame_counter==60000) _microcanvas_frame_counter = 0;

////// LOOP CONTENTS TO FOLLOW //////
${contents}
////// END OF LOOP CONTENTS //////
}
`
}