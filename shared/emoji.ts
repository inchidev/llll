/**
 * A curated emoji set for the picker, reactions, and `:shortcode:` completion.
 * Each line is the emoji, its primary shortcode, then extra search words.
 */
const SOURCE: Array<{ id: string; label: string; icon: string; lines: string }> = [
  {
    id: 'people',
    label: 'Smileys & people',
    icon: 'i-ph-smiley',
    lines: `
😀 grinning smile happy
😃 smiley happy
😄 smile happy joy
😁 grin teeth
😆 laughing lol
😅 sweat_smile relief
🤣 rofl rolling laugh
😂 joy tears laugh lol
🙂 slight_smile
🙃 upside_down
😉 wink
😊 blush happy
😇 innocent halo angel
🥰 smiling_face_with_hearts love
😍 heart_eyes love
🤩 star_struck wow
😘 kissing_heart kiss
😋 yum tasty
😛 stuck_out_tongue
😜 stuck_out_tongue_winking_eye
🤪 zany crazy
🤑 money_mouth
🤗 hugging hug
🤭 hand_over_mouth oops
🤫 shushing quiet
🤔 thinking hmm
🤐 zipper_mouth
🤨 raised_eyebrow skeptical
😐 neutral_face meh
😑 expressionless
😶 no_mouth
😏 smirk
😒 unamused
🙄 rolling_eyes eyeroll
😬 grimacing awkward
😮‍💨 exhale sigh
🤥 lying
😌 relieved
😔 pensive sad
😪 sleepy
🤤 drooling
😴 sleeping zzz
😷 mask sick
🤒 thermometer_face sick
🤕 head_bandage hurt
🤢 nauseated sick
🤮 vomiting
🥵 hot sweating
🥶 cold freezing
🥴 woozy dizzy
😵 dizzy_face
🤯 exploding_head mindblown
🤠 cowboy
🥳 partying party celebrate
😎 sunglasses cool
🤓 nerd
🧐 monocle
😕 confused
😟 worried
🙁 slight_frown
😮 open_mouth wow surprised
😯 hushed
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading puppy
😦 frowning
😧 anguished
😨 fearful scared
😰 anxious sweat
😥 disappointed_relieved
😢 cry sad tear
😭 sob crying
😱 scream
😖 confounded
😣 persevere
😞 disappointed
😓 sweat
😩 weary
😫 tired
🥱 yawning bored
😤 triumph huff
😡 rage angry
😠 angry mad
🤬 cursing swearing
😈 smiling_imp devil
💀 skull dead
💩 poop
🤡 clown
👻 ghost
👽 alien
🤖 robot bot
😺 smiley_cat
😹 joy_cat
😻 heart_eyes_cat
🙈 see_no_evil monkey
🙉 hear_no_evil
🙊 speak_no_evil
👋 wave hello hi bye
🤚 raised_back_of_hand
✋ raised_hand high_five
🖖 vulcan
👌 ok_hand okay
🤌 pinched_fingers
🤏 pinching small
✌️ v peace victory
🤞 crossed_fingers luck
🤟 love_you
🤘 metal rock
🤙 call_me shaka
👈 point_left
👉 point_right
👆 point_up
👇 point_down
☝️ point_up_2
👍 thumbsup +1 yes like
👎 thumbsdown -1 no dislike
✊ fist
👊 punch fist_bump
👏 clap applause
🙌 raised_hands hooray
👐 open_hands
🤲 palms_up
🤝 handshake deal
🙏 pray thanks please
✍️ writing
💪 muscle strong flex
🧠 brain
👀 eyes look
👁️ eye
👄 lips
🫡 salute
🫠 melting
🫶 heart_hands
🤷 shrug
🤦 facepalm
🙋 raising_hand
🙇 bow
🕺 dancer
💃 dancing
🏃 runner running
🧑‍💻 technologist developer coder
`,
  },
  {
    id: 'nature',
    label: 'Animals & nature',
    icon: 'i-ph-leaf',
    lines: `
🐶 dog puppy
🐱 cat kitten
🐭 mouse
🐹 hamster
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey_face
🐔 chicken
🐧 penguin
🐦 bird
🐤 baby_chick
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf
🐴 horse
🦄 unicorn
🐝 bee
🐛 bug
🦋 butterfly
🐌 snail
🐞 ladybug
🐢 turtle
🐍 snake
🦖 t_rex dinosaur
🐙 octopus
🦀 crab
🐠 tropical_fish
🐬 dolphin
🐳 whale
🦈 shark
🌵 cactus
🎄 christmas_tree
🌲 evergreen_tree
🌳 tree
🌴 palm_tree
🌱 seedling sprout
🌿 herb
🍀 four_leaf_clover luck
🍁 maple_leaf
🍂 fallen_leaf autumn
🌷 tulip
🌹 rose
🌻 sunflower
🌸 cherry_blossom
💐 bouquet flowers
🌞 sun_with_face
🌝 full_moon_with_face
🌙 crescent_moon
⭐ star
🌟 star2 glowing
✨ sparkles
⚡ zap lightning
🔥 fire lit hot
🌈 rainbow
☀️ sunny sun
⛅ partly_sunny
☁️ cloud
🌧️ rain
⛈️ thunderstorm
❄️ snowflake snow
☃️ snowman
💧 droplet water
🌊 ocean wave
`,
  },
  {
    id: 'food',
    label: 'Food & drink',
    icon: 'i-ph-coffee',
    lines: `
🍏 green_apple
🍎 apple
🍐 pear
🍊 tangerine orange
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🥑 avocado
🌶️ hot_pepper spicy
🌽 corn
🥕 carrot
🥐 croissant
🍞 bread
🧀 cheese
🥚 egg
🍳 cooking
🥓 bacon
🥞 pancakes
🍗 poultry_leg
🍖 meat
🌭 hotdog
🍔 hamburger burger
🍟 fries
🍕 pizza
🌮 taco
🌯 burrito
🥗 salad
🍝 spaghetti pasta
🍜 ramen noodles
🍣 sushi
🍤 fried_shrimp
🍙 rice_ball
🍚 rice
🍦 icecream
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 cake
🧁 cupcake
🍫 chocolate_bar
🍬 candy
🍿 popcorn
☕ coffee
🍵 tea
🧋 bubble_tea boba
🥤 cup_with_straw
🍺 beer
🍻 beers cheers
🥂 champagne_glass toast
🍷 wine_glass
🥃 tumbler_glass whisky
🍸 cocktail
🧊 ice_cube
`,
  },
  {
    id: 'activity',
    label: 'Activities & travel',
    icon: 'i-ph-soccer-ball',
    lines: `
⚽ soccer football
🏀 basketball
🏈 american_football
⚾ baseball
🎾 tennis
🏐 volleyball
🏓 ping_pong
🏸 badminton
⛳ golf
🏹 bow_and_arrow
🎣 fishing
🥊 boxing_glove
🎿 ski
🏂 snowboarder
🏋️ weight_lifter
🚴 bicyclist
🏆 trophy win
🥇 first_place gold
🥈 second_place silver
🥉 third_place bronze
🏅 medal
🎖️ military_medal
🎫 ticket
🎪 circus_tent
🎭 performing_arts
🎨 art palette
🎬 clapper movie
🎤 microphone karaoke
🎧 headphones
🎼 musical_score
🎹 piano
🥁 drum
🎸 guitar
🎮 video_game gaming controller
🕹️ joystick
🎲 game_die dice
🧩 jigsaw puzzle
♟️ chess_pawn
🎯 dart bullseye target
🎳 bowling
🚗 car
🚕 taxi
🚌 bus
🏎️ race_car
🚓 police_car
🚑 ambulance
🚒 fire_engine
🚲 bike
🛴 scooter
🏍️ motorcycle
🚨 rotating_light alarm
🚀 rocket launch ship
🛸 flying_saucer ufo
✈️ airplane plane
🚁 helicopter
⛵ sailboat
🚢 ship
⚓ anchor
🗺️ map
🗽 statue_of_liberty
🏠 house home
🏢 office building
🏥 hospital
🏦 bank
🏰 castle
⛺ tent camping
🌋 volcano
🏝️ island
🌅 sunrise
🌃 night_with_stars
🎉 tada party celebrate hooray
🎊 confetti_ball
🎈 balloon
🎁 gift present
🎀 ribbon
`,
  },
  {
    id: 'objects',
    label: 'Objects',
    icon: 'i-ph-lightbulb',
    lines: `
⌚ watch
📱 iphone phone mobile
💻 computer laptop
⌨️ keyboard
🖥️ desktop
🖨️ printer
🖱️ mouse_three_button
💾 floppy_disk save
💿 cd
📷 camera
📸 camera_flash
🎥 movie_camera
📺 tv
📻 radio
🎙️ studio_microphone podcast
⏰ alarm_clock
⏳ hourglass waiting
🔋 battery
🔌 electric_plug
💡 bulb idea light
🔦 flashlight
🕯️ candle
💸 money_with_wings
💵 dollar money
💰 moneybag
💳 credit_card
💎 gem diamond
⚖️ scales
🧰 toolbox
🔧 wrench
🔨 hammer
⚒️ hammer_and_pick
🛠️ tools
⛏️ pick
🔩 nut_and_bolt
⚙️ gear settings
🧱 bricks
⛓️ chains
🧲 magnet
🔫 gun water_pistol
💣 bomb
🔪 knife
🛡️ shield
🔮 crystal_ball
🧿 nazar_amulet
💈 barber
🔭 telescope
🔬 microscope
🩺 stethoscope
💊 pill
💉 syringe
🧬 dna
🧪 test_tube
🌡️ thermometer
🧹 broom
🧺 basket
🧻 roll_of_paper
🚽 toilet
🛁 bathtub
🔑 key
🗝️ old_key
🚪 door
🛋️ couch
🛏️ bed
🧸 teddy_bear
🖼️ frame_with_picture
🛒 shopping_cart
✉️ envelope email
📧 e-mail
📨 incoming_envelope
📦 package box shipping
📫 mailbox
📝 memo note pencil
📄 page_facing_up document
📑 bookmark_tabs
📊 bar_chart
📈 chart_with_upwards_trend up growth
📉 chart_with_downwards_trend down
📅 date calendar
📆 calendar_spiral
🗓️ spiral_calendar
📇 card_index
📋 clipboard
📁 file_folder
📂 open_file_folder
🗂️ card_index_dividers
📌 pushpin pin
📍 round_pushpin location
📎 paperclip attachment
✂️ scissors
🖊️ pen
✏️ pencil2
🔍 mag search
🔒 lock
🔓 unlock
🔔 bell notification
🔕 no_bell mute
📣 mega announcement
📢 loudspeaker
💬 speech_balloon chat comment
💭 thought_balloon
🗯️ anger_right
📚 books
📖 book open_book
🔗 link
🏷️ label tag
`,
  },
  {
    id: 'symbols',
    label: 'Symbols',
    icon: 'i-ph-heart',
    lines: `
❤️ heart love red_heart
🧡 orange_heart
💛 yellow_heart
💚 green_heart
💙 blue_heart
💜 purple_heart
🖤 black_heart
🤍 white_heart
🤎 brown_heart
💔 broken_heart
❣️ heart_exclamation
💕 two_hearts
💞 revolving_hearts
💓 heartbeat
💗 heartpulse
💖 sparkling_heart
💘 cupid
💝 gift_heart
💯 100 hundred perfect
💢 anger
💥 boom collision
💫 dizzy
💦 sweat_drops
💨 dash
🕳️ hole
💤 zzz sleep
✅ white_check_mark check done yes
☑️ ballot_box_with_check
✔️ heavy_check_mark
❌ x cross no wrong
❎ negative_squared_cross_mark
➕ heavy_plus_sign plus
➖ heavy_minus_sign minus
➗ heavy_division_sign
✖️ heavy_multiplication_x
❓ question
❔ grey_question
❗ exclamation important
❕ grey_exclamation
‼️ bangbang
⁉️ interrobang
⚠️ warning caution
🚫 no_entry_sign forbidden
⛔ no_entry
🛑 stop_sign
♻️ recycle
🔴 red_circle
🟠 orange_circle
🟡 yellow_circle
🟢 green_circle
🔵 large_blue_circle
🟣 purple_circle
⚫ black_circle
⚪ white_circle
🟥 red_square
🟩 green_square
🟦 blue_square
⬛ black_large_square
⬜ white_large_square
🔶 large_orange_diamond
🔷 large_blue_diamond
➡️ arrow_right
⬅️ arrow_left
⬆️ arrow_up
⬇️ arrow_down
↩️ leftwards_arrow_with_hook
↪️ arrow_right_hook
🔄 arrows_counterclockwise refresh
🔁 repeat
🔀 twisted_rightwards_arrows shuffle
▶️ arrow_forward play
⏸️ pause_button
⏹️ stop_button
⏺️ record_button
⏭️ next_track
⏮️ previous_track
🔼 arrow_up_small
🔽 arrow_down_small
🆕 new
🆗 ok
🆒 cool
🆓 free
🆙 up
🆘 sos help
ℹ️ information_source info
🔞 underage
©️ copyright
®️ registered
™️ tm trademark
#️⃣ hash
0️⃣ zero
1️⃣ one
2️⃣ two
3️⃣ three
4️⃣ four
5️⃣ five
🔟 keycap_ten
🏁 checkered_flag finish
🚩 triangular_flag_on_post red_flag
🏳️ white_flag
🏴 black_flag
🏳️‍🌈 rainbow_flag pride
`,
  },
]

export type EmojiEntry = {
  emoji: string
  name: string
  keywords: string[]
  category: string
}

export type EmojiCategory = {
  id: string
  label: string
  icon: string
  emoji: EmojiEntry[]
}

let categoriesCache: EmojiCategory[] | null = null

export function emojiCategories(): EmojiCategory[] {
  categoriesCache ??= SOURCE.map(category => ({
    id: category.id,
    label: category.label,
    icon: category.icon,
    emoji: category.lines.trim().split('\n').map((line) => {
      const [emoji = '', name = '', ...keywords] = line.trim().split(/\s+/)
      return { emoji, name, keywords, category: category.id }
    }),
  }))
  return categoriesCache
}

let allCache: EmojiEntry[] | null = null
let byNameCache: Map<string, EmojiEntry> | null = null

function allEmoji(): EmojiEntry[] {
  allCache ??= emojiCategories().flatMap(category => category.emoji)
  return allCache
}

function byName(): Map<string, EmojiEntry> {
  byNameCache ??= new Map(allEmoji().map(entry => [entry.name, entry]))
  return byNameCache
}

export function emojiByName(name: string): EmojiEntry | undefined {
  return byName().get(name.toLowerCase())
}

export function emojiName(emoji: string): string | undefined {
  return allEmoji().find(entry => entry.emoji === emoji)?.name
}

/** Shortcode prefix matches first, then keyword and substring matches. */
export function searchEmoji(query: string, limit = 40): EmojiEntry[] {
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '')
  if (!needle) return []
  const scored: Array<[number, EmojiEntry]> = []
  for (const entry of allEmoji()) {
    let score = -1
    if (entry.name === needle) score = 0
    else if (entry.name.startsWith(needle)) score = 1
    else if (entry.keywords.some(word => word.startsWith(needle))) score = 2
    else if (entry.name.includes(needle)) score = 3
    if (score >= 0) scored.push([score, entry])
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
    .slice(0, limit)
    .map(([, entry]) => entry)
}

/** Replaces known `:shortcode:` text with its emoji, outside code. */
export function replaceShortcodes(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((part, index) => index % 2
      ? part
      : part.replace(/:([\w+-]{1,32}):/g, (full, name: string) => emojiByName(name)?.emoji ?? full))
    .join('')
}

const EMOJI_ONLY = /^(?:\s|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F|\u20E3|[#*0-9])+$/u
const EMOJI_UNIT = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu

/** Short messages made only of emoji render large, like Discord's jumbo emoji. */
export function isJumboEmoji(content: string): boolean {
  const text = content.trim()
  if (!text || text.length > 120 || !EMOJI_ONLY.test(text) || /^[\s#*0-9]+$/.test(text)) return false
  const count = text.match(EMOJI_UNIT)?.length ?? 0
  return count > 0 && count <= 27
}
