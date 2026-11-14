# ODYSSEY v2 外部素材の出典とライセンス

外部ファイルはすべてここに1行ずつ残す（ファイル・出典ページ・作者・ページ記載のライセンス・取得日）。

## キャラクター（scout-characters, 2026-11-14）

外部から取ったファイルと、それを焼き込んだv2のファイル。取得はすべてログイン・アカウント・支払い・新規規約同意なし（itch.ioの無料ダウンロード／OpenGameArtの直リンク）。

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/characters/hoplite.glb, kikones.glb, villager_m.glb（素体・目・眉・髪） | Universal Base Characters[Standard].zip の Superhero_Male_FullBody.gltf/.bin と T_Superhero_Male_*.png, T_Eye_*.png, Hair_Beard / Hair_Buzzed / Hair_SimpleParted（Origin at 0, glTF） | https://quaternius.itch.io/universal-base-characters （作者サイト https://quaternius.com/packs/universalbasecharacters.html） | Quaternius | 「Free to use in personal, educational and commercial projects. (CC0 License)」「Creative Commons Zero v1.0 Universal」。同梱 License_Standard.txt: CC0 1.0 Universal | 2026-11-14 |
| assets/characters/villager_f.glb（素体・目・眉・髪） | 同zipの Superhero_Female_FullBody.gltf/.bin と T_Superhero_Female_*.png, Hair_Buns | 同上 | Quaternius | 同上（CC0） | 2026-11-14 |
| assets/characters/anim/anim_male.glb, anim_female.glb（UAL1由来の動き。骨格をUBCへリターゲットして焼き直し） | universal_animation_librarystandard.zip の Godot/AnimationLibrary_Godot_Standard.glb | https://opengameart.org/content/universal-animation-library （作者のitch: https://quaternius.itch.io/universal-animation-library ） | quaternius | 「License(s): CC0」。同梱 License.txt: CC0 1.0 Universal | 2026-11-14 |
| assets/characters/anim/anim_male.glb, anim_female.glb（UAL2由来の動き。同上） | universal_animation_library_2standard.zip の Unreal-Godot/UAL2_Standard.glb | https://opengameart.org/content/universal-animation-library-2 （作者のitch: https://quaternius.itch.io/universal-animation-library-2 ） | quaternius | 「License(s): CC0」。同梱 License.txt: CC0 1.0 Universal | 2026-11-14 |
| assets/characters/gear.glb のノード aspis, aspis_black（形状とテクスチャ。テクスチャは1024pxに縮小） | aspis.zip の aspis.fbx, textures/base/*.png, textures/black paint/BaseColor.png | https://opengameart.org/content/aspis-hoplite-shield | ninelionar | 「License(s): CC0」 | 2026-11-14 |

自作（外部ファイルなし）: gear.glb の helmet_corinthian, helmet_thracian, helmet_pilos, dory, javelin, xiphos, kopis, pelta、盾の握り（porpax/antilabe）、各キャラの衣服・防具メッシュ（Cuirass, Corslet, Tunic, Sleeves, Chiton, Pteruges, Greaves, Cloak, TunicSkirt, Peplos, PeplosSkirt, Apoptygma）、マント用の骨 cloak_01〜03、手続き生成テクスチャ（青銅・麻・革・木・馬毛）。生成スクリプトは tools/characters/build_chars.py。anim_male.glb の Spear_Thrust_Overhand は、上記UAL1・UAL2（CC0）の姿勢を組み合わせて作ったクリップ（tools/characters/harness/job9_events.js）。

## 世界・光・音（scout-world, 2026-11-14）

取得はすべてログイン・アカウント・支払い・新規規約同意なし（Poly Haven公開API、ambientCGの /get、Kenneyの「Continue without donating」と同じ公開リンク、OpenGameArt直リンク、Wikimedia Commons公開API）。ライセンス欄は出典ページの記載。Poly Havenは各アセットページの構造化データ「CC0 1.0 Universal - public domain dedication, no attribution required」、ambientCGは https://ambientcg.com/license の「All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License」。

### 空（HDRI）

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/world/hdri/day_rustig_koppie_puresky_2k.hdr | rustig_koppie_puresky_2k.hdr | https://polyhaven.com/a/rustig_koppie_puresky | Greg Zaal (original), Jarod Guest (sky edits) | CC0 1.0 | 2026-11-14 |
| assets/world/hdri/dusk_qwantani_sunset_puresky_2k.hdr | qwantani_sunset_puresky_2k.hdr | https://polyhaven.com/a/qwantani_sunset_puresky | Greg Zaal (photography), Jarod Guest (processing) | CC0 1.0 | 2026-11-14 |

### PBR素材（v2側は縮小・色調整・チャンネル詰め直しをした派生物）

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/world/materials/sand/* | aerial_beach_01 2k (Diffuse, nor_gl, arm, Displacement) | https://polyhaven.com/a/aerial_beach_01 | Rob Tuytel | CC0 1.0 | 2026-11-14 |
| assets/world/materials/sand_fine/* | dense_sand 2k | https://polyhaven.com/a/dense_sand | Dimitrios Savva | CC0 1.0 | 2026-11-14 |
| assets/world/materials/earth/* | dry_ground_rocks 2k | https://polyhaven.com/a/dry_ground_rocks | Rob Tuytel | CC0 1.0 | 2026-11-14 |
| assets/world/materials/grass/* | grass_ground 2k | https://polyhaven.com/a/grass_ground | Charlotte Baglioni | CC0 1.0 | 2026-11-14 |
| assets/world/materials/rock/*（rock_obj_* はその1k版） | marble_cliff_03 2k | https://polyhaven.com/a/marble_cliff_03 | Amal Kumar | CC0 1.0 | 2026-11-14 |
| assets/world/materials/wood/* | brown_planks_03 1k | https://polyhaven.com/a/brown_planks_03 | Rob Tuytel | CC0 1.0 | 2026-11-14 |
| assets/world/materials/terracotta/*（色をテラコッタへ変更） | clay_plaster 1k | https://polyhaven.com/a/clay_plaster | Amal Kumar | CC0 1.0 | 2026-11-14 |
| assets/world/materials/marble/*（粗さを再マップ、clay_plasterの法線で風化の凹凸を合成） | Marble014_1K-JPG.zip | https://ambientcg.com/a/Marble014 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/linen/* | Fabric066_1K-JPG.zip | https://ambientcg.com/a/Fabric066 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/bark/* | Bark001_1K-JPG.zip | https://ambientcg.com/a/Bark001 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/foliage_cards/olive_cluster_rgba.png, mastic_cluster_rgba.png（葉を切り抜いて小枝・房に並べ直した派生物。olive_tree.glb, bush_mastic.glb に埋め込み） | LeafSet013_1K-JPG.zip | https://ambientcg.com/a/LeafSet013 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/foliage_cards/cypress_sprig_rgba.png（cypress_tree.glb に埋め込み） | LeafSet019_1K-JPG.zip | https://ambientcg.com/a/LeafSet019 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/grass_dry/*（穂の草カード） | Foliage002_1K-JPG.zip | https://ambientcg.com/a/Foliage002 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |
| assets/world/materials/foliage_cards/grass_tuft_rgba.png（葉身を束ねた草むら） | Foliage005_1K-JPG.zip | https://ambientcg.com/a/Foliage005 | ambientCG (Lennart Demes) | CC0 1.0 | 2026-11-14 |

### 3Dモデル（Poly Havenの実写スキャン。Blenderで頂点数を削減してGLB化）

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/world/models/rock_face_01.glb | rock_face_01_1k.gltf (+bin, 1kテクスチャ) | https://polyhaven.com/a/rock_face_01 | Dario Barresi | CC0 1.0 | 2026-11-14 |
| assets/world/models/rock_face_02.glb | rock_face_02_1k.gltf | https://polyhaven.com/a/rock_face_02 | Dario Barresi, Rico Cilliers | CC0 1.0 | 2026-11-14 |
| assets/world/models/boulder_namaqualand_05.glb | namaqualand_boulder_05_1k.gltf | https://polyhaven.com/a/namaqualand_boulder_05 | Jenelle van Heerden, Dario Barresi | CC0 1.0 | 2026-11-14 |
| assets/world/models/cliff_namaqualand_01.glb | namaqualand_cliff_01_1k.gltf | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden, Rico Cilliers | CC0 1.0 | 2026-11-14 |
| assets/world/models/fire_pit_stone.glb | stone_fire_pit_1k.gltf | https://polyhaven.com/a/stone_fire_pit | Sebastian Platen | CC0 1.0 | 2026-11-14 |
| assets/world/models/wicker_basket.glb | wicker_basket_01_1k.gltf | https://polyhaven.com/a/wicker_basket_01 | Kuutti Siitonen | CC0 1.0 | 2026-11-14 |

自作（外部の形状なし。Blender 5.1をヘッドレスで実行して寸法どおりに作成、上表のPBR素材を埋め込み）: temple_kit.glb, temple_ruin.glb（ドーリス式、柱5.4 m・下径0.95 m・20条の溝・エンタシス）, olive_tree.glb, cypress_tree.glb, bush_mastic.glb, camp_kit.glb, camp_scene.glb（天幕・槍掛け・アンフォラ・荷車・焚き火の薪）, sheep_pen.glb, cave_mouth.glb（扉岩つき、頂点AO焼き込み）, galley.glb（ペンテコンター約28 m）, boat_small.glb。自作テクスチャ: assets/world/water/water_ripples_nor.jpg（FFT海面スペクトルから生成）, assets/world/materials/ship_eye/ship_eye_rgba.png（船首の目）。生成スクリプトは outputs/odyssey-v2-2026-11-14/scout-world.md に記載。

### 音（v2側は切り出し・ピッチ変更・重ね・正規化・ループ化をした派生物。Ogg Vorbis）

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/audio/step_grass_01-05, step_wood_01-05, hit_shield_01-05（Plate+Wood）, hit_flesh_01-05（Punch）, bronze_clatter_01-04（金属音の層）, giant_step_01-03（重低音・瓦礫の層） | Impact Sounds 1.0 (kenney_impact-sounds.zip): footstep_grass_*, footstep_wood_*, impactPlate_heavy_*, impactWood_heavy_*, impactPunch_heavy_*, impactMetal_light_*, impactSoft_heavy_*, impactMining_* | https://kenney.nl/assets/impact-sounds | Kenney (kenney.nl) | 「CC0 licensed」、同梱License.txt: Creative Commons Zero, CC0 | 2026-11-14 |
| assets/audio/hit_flesh_01-05（斬撃の層） | RPG Audio (kenney_rpg-audio.zip): knifeSlice.ogg, knifeSlice2.ogg | https://kenney.nl/assets/rpg-audio | Kenney (kenney.nl) | 「CC0 licensed」、同梱License.txt: CC0 | 2026-11-14 |
| assets/audio/step_sand_01-06, step_stone_01-06 | Fantozzi-footsteps.7z (Fantozzi-Sand*.ogg, Fantozzi-Stone*.ogg) | https://opengameart.org/content/fantozzis-footsteps-grasssand-stone | Fantozzi（投稿 qubodup） | CC0 | 2026-11-14 |
| assets/audio/swing_01-06, clash_01-06 | sword_-_starninjas_1.zip, sword_clash_-_starninjas_0.zip | https://opengameart.org/content/20-sword-sound-effects-attacks-and-clashes | StarNinjas | CC0 | 2026-11-14 |
| assets/audio/bronze_clatter_01-04（鎧の層） | footsteps.zip (step_metal*.ogg) | https://opengameart.org/content/footsteps-leather-cloth-armor | HaelDB | OGA-BY 3.0 / CC0 の二重。CC0を選択 | 2026-11-14 |
| assets/audio/wave_crash_01-04 | wave_01〜04_cc0-18363__jasinski__alkaibeach.flac | https://opengameart.org/content/beach-ocean-waves | jasinski（投稿 qubodup） | CC0 | 2026-11-14 |
| assets/audio/crowd_loop, crowd_shout_01-03 | crowd_shouting_0.ogg | https://opengameart.org/content/crowd-shoutingspeaking-ambience | StarNinjas | CC0 | 2026-11-14 |
| assets/audio/fire_loop | fire.wav | https://opengameart.org/content/fireplace-sound-loop | PagDev | CC0 | 2026-11-14 |
| assets/audio/giant_roar_02-03 | troll-roars_0.ogg | https://opengameart.org/content/big-scary-troll-sounds | Darsycho | CC0 | 2026-11-14 |
| assets/audio/giant_roar_01 | monster_roar.wav | https://opengameart.org/content/cc0-deep-monster-roar | trazzz123 | CC0 | 2026-11-14 |
| assets/audio/giant_step_01-03（足音の芯） | stomp.flac | https://opengameart.org/content/mech-stomp-step-sound | hc | CC0 | 2026-11-14 |
| assets/audio/surf_loop | On a pebble beach.ogg | https://commons.wikimedia.org/wiki/File:On_a_pebble_beach.ogg | earthcalling | Public domain | 2026-11-14 |
| assets/audio/wind_loop | Howling wind.ogg | https://commons.wikimedia.org/wiki/File:Howling_wind.ogg | Tvabutzku1234 | CC0 | 2026-11-14 |
| assets/audio/gull_01-04 | Gull 1.ogg | https://commons.wikimedia.org/wiki/File:Gull_1.ogg | avphillips | Public domain | 2026-11-14 |
| assets/audio/gull_05 | Gull 2.ogg | https://commons.wikimedia.org/wiki/File:Gull_2.ogg | avphillips | Public domain | 2026-11-14 |
| assets/audio/gull_06-07 | XC707075 - European Herring Gull - Larus argentatus.mp3 | https://commons.wikimedia.org/wiki/File:XC707075_-_European_Herring_Gull_-_Larus_argentatus.mp3 | Sonothèque ADVL (xeno-canto XC707075) | CC0 | 2026-11-14 |
| assets/audio/giant_roar_01, giant_roar_03（低音の層） | Yellowstone sound library - Grizzly Bears Roar - 001.mp3 | https://commons.wikimedia.org/wiki/File:Yellowstone_sound_library_-_Grizzly_Bears_Roar_-_001.mp3 | NPS & MSU Acoustic Atlas / Jennifer Jerrett | Public domain | 2026-11-14 |
| assets/audio/giant_growl_01-03 | Monster growls.ogg | https://commons.wikimedia.org/wiki/File:Monster_growls.ogg | stilgar | Public domain | 2026-11-14 |

## 怪物・動物（scout-creatures, 2026-11-14）

取得経路: 5体とも原典はSketchfabのCC BY 4.0作品（ページ記載: 「CC Attribution」 http://creativecommons.org/licenses/by/4.0/ 、「Author must be credited. Commercial use is allowed.」。Sketchfab公開API `https://api.sketchfab.com/v3/models/<uid>` の license 欄で確認）。Sketchfab本体のダウンロードはログインが要るため使っていない。ファイルは、作者のCC BYを引き継いで再配布しているAllen Institute for AIのデータセット Objaverse（Hugging Face `allenai/objaverse`、ログイン・gated・規約同意なし、データセットのライセンスは ODC-By 1.0、各物体は作者のライセンス）から取得した。ゲームからの抜き出しでないことは各ページの説明文で確認（自作と明記、またはゲーム名・既存IPの記載なし）。CC BYのため、ゲーム内のクレジット画面に下表の作者名・作品名・ライセンスを表示すること。

| v2のファイル | 元ファイル | 出典ページ | 作者 | ページ記載のライセンス | 取得日 |
| --- | --- | --- | --- | --- | --- |
| assets/creatures/polyphemus/polyphemus.glb（改変: 両目を除去し額に一つ目とまぶたと eye 骨を追加、旧両目まわりの肌テクスチャを額の肌で上塗り、棍棒を柄と頭に分割し clubTip 骨を追加、骨名変更、10 m に拡大、クリップ名変更、8動作を骨に追加。修正第1回（2026-11-14）: 実行時に下顎の牙のメッシュを非表示、石の玉の棍棒を樹皮のオリーブの幹（形状は js/cyclops.js で生成、樹皮は上表の Bark001）に置換） | https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-016/bceb1cb47186457c8571a23e6aff1b8e.glb 「Troll」 | https://sketchfab.com/3d-models/troll-bceb1cb47186457c8571a23e6aff1b8e | SJunior3d (https://sketchfab.com/sjunior3d) | CC Attribution (CC BY 4.0) | 2026-11-14 |
| assets/creatures/sea-serpent/pistosaur.glb（無改変） | https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-036/773667575a264c7baa4ec404115a044b.glb 「Pistosaur Animated」 | https://sketchfab.com/3d-models/pistosaur-animated-773667575a264c7baa4ec404115a044b | RickStikkelorum (https://sketchfab.com/ricksticky) | CC Attribution (CC BY 4.0) | 2026-11-14 |
| assets/creatures/seagull/seagull.glb（無改変） | https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-000/dc42ffc81c86480e9e7f7752fa134174.glb 「Seagull」 | https://sketchfab.com/3d-models/seagull-dc42ffc81c86480e9e7f7752fa134174 | Dayvable (https://sketchfab.com/Dayvable) | CC Attribution (CC BY 4.0) | 2026-11-14 |
| assets/creatures/ram/ram.glb（無改変） | https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-000/d02aca356cfb4d5b9836b7c4663bd447.glb 「Bighorn Sheep」 | https://sketchfab.com/3d-models/bighorn-sheep-d02aca356cfb4d5b9836b7c4663bd447 | Nioma van der Steen (https://sketchfab.com/fromthestone) | CC Attribution (CC BY 4.0) | 2026-11-14 |

自作（外部ファイルなし）: polyphemus.glb 内の一つ目のテクスチャ cyclops_eye（Python手続き生成）、まぶたの形状、追加8動作（cStomp, cThrow, cRoar, cFall, cStagger, cRecover, cSleep, cWake。骨への姿勢合成と2骨IK）。生成スクリプトは tools/creatures/ 。

## 組み込み（integrator, 2026-11-14）

外部ファイルの追加なし。ゲーム本体（js/）は上の素材だけを使う。three.js r158（MIT License, https://github.com/mrdoob/three.js ）は v1 と同じく実行時に jsDelivr から読み込み、v2 フォルダにはファイルを置いていない。CC BY 4.0 の4点（ポリュペモスの元「Troll」、海蛇、カモメ、羊）は、ゲーム終わりの画面の © ボタンで作者・作品名・ライセンス・出典を表示する（js/main.js の CREDITS）。
CC BY 4.0 の4点のクレジットは、修正第1回から死んだときの画面と、遊んでいる間の画面右下（消音ボタンの左）の © からも開ける。

## 修正第1回（fixer, 2026-11-14）

- 外部ファイルの追加なし。島の内側の廃墟・荷車・壺は、上表の自作 temple_kit.glb / camp_kit.glb（それまで未使用）の部品。沖の島影は js/world.js が形状を生成（テクスチャなし）。
- 使っていなかった外部ファイルを v2 から外した: assets/creatures/boar/boar.glb（Wild Boar, jbnotjeebe, CC BY 4.0。どこからも読んでいなかった）、assets/tex/concrete_floor_02_diff.jpg / _nor.jpg / _rough.jpg（v1 から複写されたまま未使用・未記載）。v1 の同名ファイルはそのまま。外したファイルは作業場に退避しただけで、v1 と出典の記録は残る。


## 修正第2回（fixer, 2026-11-14）

- 外部ファイルの追加なし（ダウンロードはしていない）。次の自作ファイルを Blender 5.1 のヘッドレス実行で作り直した。外部の形状は使っていない。素材は上表の PBR（wood, linen, bark, terracotta, rock）と自作の色。
  - assets/world/models/galley.glb, boat_small.glb: tools/world/blender/build_ships.py を直して再生成。櫂は船内の漕ぎ座に寝かせ、船尾を閉じて反り上がる一続きの船尾飾りにした。舵櫂は別ノード galley_steer。
  - assets/world/models/camp_kit.glb, camp_scene.glb, camp_layout.json: 新しいスクリプト tools/world/blender/build_camp2.py で作成（天幕5種・縫い目・張り綱・杭、槍掛け、袋、寝具、木箱、薪、三脚と青銅の鍋、物干し、杭の柵、アンフォラ、荷車、焚き火の薪）。旧版は outputs/odyssey-v2-2026-11-14/fix-round-2/scripts/ に退避。
- assets/world/models/wicker_basket.glb（Poly Haven, CC0、上表の行）は、陣営のかごとして使うようにした（それまで未使用）。
- 陣営の盾は、上表の gear.glb の aspis_black（ninelionar, CC0）を複製して置いている。
- 使っていなかった次のファイルを v2 から外した（ゲームからは読んでいない。dev/character-demo.html だけが使っていた）: assets/characters/villager_m.glb、villager_f.glb、assets/characters/anim/anim_female.glb。削除ではなく outputs/odyssey-v2-2026-11-14/fix-round-2/unused-assets/ へ移しただけで、出典の行（上表）はそのまま残す。dev/character-demo.html の村人と女性の動きは、この3ファイルを戻さないと表示されない。
- 巨人の肌の細かい凹凸（毛穴・しわ）と棍棒の木口の年輪は、実行時に canvas で生成するテクスチャ（js/cyclops.js）。外部ファイルではない。
