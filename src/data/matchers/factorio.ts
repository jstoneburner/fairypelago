import { IconMatcher } from '../../types/icon-types.js'

export const factorioIcons: IconMatcher[] = [
  // Science packs (progressive — use automation pack as representative icon)
  { pattern: [/progressive-science-pack/], emoji: 'factorio_science_auto' },
  { pattern: [/automation-science-pack/], emoji: 'factorio_science_auto' },
  { pattern: [/logistic-science-pack/], emoji: 'factorio_science_logistic' },
  { pattern: [/military-science-pack/], emoji: 'factorio_science_military' },
  { pattern: [/chemical-science-pack/], emoji: 'factorio_science_chemical' },
  { pattern: [/production-science-pack/], emoji: 'factorio_science_production' },
  { pattern: [/utility-science-pack/], emoji: 'factorio_science_utility' },
  { pattern: [/space-science-pack/], emoji: 'factorio_science_space' },

  // Rocket / win condition
  { pattern: ['rocket-silo', /rocket-silo/], emoji: 'factorio_rocket_silo' },
  { pattern: [/progressive-rocketry/, 'rocketry', 'explosive-rocketry', 'atomic-bomb'], emoji: 'factorio_rocketry' },

  // Nuclear
  { pattern: ['nuclear-power', /nuclear/], emoji: 'factorio_nuclear' },
  { pattern: ['kovarex-enrichment-process', /kovarex/], emoji: 'factorio_kovarex' },

  // Combat — turrets
  { pattern: ['laser-turret', /progressive-turret/], emoji: 'factorio_laser_turret' },
  { pattern: ['gun-turret'], emoji: 'factorio_gun_turret' },

  // Combat — laser damage research
  { pattern: [/progressive-laser-weapons-damage/, /laser-weapons-damage/], emoji: 'factorio_laser_damage' },

  // Combat — vehicles
  { pattern: ['spidertron'], emoji: 'factorio_spidertron' },
  { pattern: ['tank'], emoji: 'factorio_tank' },
  { pattern: ['automobilism', 'car', /progressive-vehicle/], emoji: 'factorio_car' },

  // Armor
  { pattern: [/progressive-armor/, 'heavy-armor', 'modular-armor', /power-armor/], emoji: 'factorio_armor' },

  // Robotics
  { pattern: ['logistic-robotics', /logistic-robot/], emoji: 'factorio_logistic_robotics' },
  { pattern: ['construction-robotics', /construction-robot/, /personal-roboport/], emoji: 'factorio_construction_robotics' },

  // Followers (combat robots)
  { pattern: [/progressive-follower/, 'defender', 'distractor', 'destroyer'], emoji: 'factorio_destroyer' },

  // Train
  { pattern: [/progressive-train/, 'railway', 'automated-rail-transportation', /locomotive/, /train/], emoji: 'factorio_train' },

  // Mining
  { pattern: [/progressive-mining-productivity/, /mining-productivity/, /mining/], emoji: 'factorio_mining' },

  // Inserters
  { pattern: [/progressive-inserter/, /inserter/], emoji: 'factorio_inserter' },

  // Oil / processing
  { pattern: [/progressive-processing/, /oil-processing/, /coal-liquefaction/, /uranium-processing/, /steel-processing/], emoji: 'factorio_oil' },

  // Walls
  { pattern: [/progressive-wall/, 'stone-wall', 'gate'], emoji: 'factorio_wall' },

  // Traps
  { pattern: [/Trap$/], emoji: 'factorio_trap' },
]
