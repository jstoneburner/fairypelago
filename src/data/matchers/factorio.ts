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

  // Space Age science packs
  { pattern: [/metallurgic-science-pack/], emoji: 'factorio_science_metallurgic' },
  { pattern: [/electromagnetic-science-pack/], emoji: 'factorio_science_electromagnetic' },
  { pattern: [/agricultural-science-pack/], emoji: 'factorio_science_agricultural' },
  { pattern: [/cryogenic-science-pack/], emoji: 'factorio_science_cryogenic' },
  { pattern: [/promethium-science-pack/], emoji: 'factorio_science_promethium' },

  // Rocket / win condition
  { pattern: ['rocket-silo', /rocket-silo/], emoji: 'factorio_rocket_silo' },
  { pattern: [/progressive-rocketry/, 'rocketry', 'explosive-rocketry', 'atomic-bomb'], emoji: 'factorio_rocketry' },
  { pattern: [/stronger-explosives/, /explosive-capsule/, /explosives/], emoji: 'factorio_explosives' },

  // Nuclear
  { pattern: ['nuclear-power', /nuclear/], emoji: 'factorio_nuclear' },
  { pattern: ['kovarex-enrichment-process', /kovarex/], emoji: 'factorio_kovarex' },

  // Combat — turrets
  { pattern: ['laser-turret', /progressive-turret/], emoji: 'factorio_laser_turret' },
  { pattern: ['gun-turret'], emoji: 'factorio_gun_turret' },

  // Combat — laser research
  { pattern: [/progressive-laser-weapons-damage/, /laser-weapons-damage/], emoji: 'factorio_laser_damage' },
  { pattern: [/laser-shooting-speed/], emoji: 'factorio_laser_turret' },

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

  // Oil / processing — base game fluids and industrial refining
  { pattern: [/progressive-processing/, /oil-processing/, /coal-liquefaction/, /uranium-processing/, /steel-processing/], emoji: 'factorio_oil' },

  // Space Age — Vulcanus (lava, foundry, casting, tungsten, calcite)
  { pattern: [/lava-processing/], emoji: 'factorio_lava' },
  { pattern: [/foundry/, /casting/], emoji: 'factorio_foundry' },
  { pattern: [/tungsten/], emoji: 'factorio_tungsten_ore' },
  { pattern: [/calcite/], emoji: 'factorio_calcite' },

  // Space Age — Fulgora (holmium, electromagnetic plant, recycling)
  { pattern: [/holmium/], emoji: 'factorio_holmium_ore' },
  { pattern: [/electromagnetic-plant/], emoji: 'factorio_electromagnetic_plant' },
  { pattern: [/recycling/], emoji: 'factorio_recycler' },

  // Space Age — Gleba (biochamber, biolabs, bioflux, agricultural tower, carbon fibre)
  { pattern: [/biochamber/, /biolabs/, /bioflux/, /agricultural-tower/], emoji: 'factorio_biochamber' },
  { pattern: [/carbon-fibre/], emoji: 'factorio_carbon_fiber' },

  // Space Age — Aquilo (cryogenic plant, ice platform, fusion)
  { pattern: [/cryogenic-plant/, /ice-platform/], emoji: 'factorio_cryogenic_plant' },
  { pattern: [/fusion/], emoji: 'factorio_fusion_reactor' },

  // Space Age — space platform and asteroids
  { pattern: [/space-platform/], emoji: 'factorio_space_platform' },
  { pattern: [/asteroid/], emoji: 'factorio_asteroid_collector' },

  // Space Age — elevated rail
  { pattern: [/elevated-rail/], emoji: 'factorio_elevated_rail' },

  // Walls
  { pattern: [/progressive-wall/, 'stone-wall', 'gate'], emoji: 'factorio_wall' },

  // Traps
  { pattern: [/Trap$/], emoji: 'factorio_trap' },
]
