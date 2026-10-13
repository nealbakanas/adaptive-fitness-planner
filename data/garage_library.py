# Categorise the Garage Strength "Movement Library" playlist.
# Usage: yt-dlp --flat-playlist -J "<playlist url>" > pl.json && python3 data/garage_library.py pl.json data/garage-strength-library.json
import json, re, sys
d = json.load(open(sys.argv[1]))

SKIP = {'-Ayp2W8tmfc'}  # "UNBROKEN Example" — not a single exercise

# Title fixes: strip prefixes, the category suffixes on the short clips, and typos.
SUFFIX = r'\s*(unilateral squat|hip hinge|pressing|overhead press|power jerks|PJ|\| movement library|1)\s*$'
FIX = {'Seated Barbell Extenision': 'Seated Barbell Extension', 'Dowel zombie squad': 'Dowel zombie squat',
       'Air squat heals elevated': 'Air squat, heels elevated', 'Kettle-bell Swings': 'Kettlebell Swings',
       'Preying Mantis Lunge': 'Praying Mantis Lunge', 'Pallof V UPS': 'Pallof V-Ups',
       'Rotating Jump Step UPS': 'Rotating Jump Step-Ups', 'Rolling Tricep Push UPS': 'Rolling Tricep Push-Ups',
       'Banded Split Squat/ISO Lunge Hold': 'Banded Split Squat / Iso Lunge Hold',
       'Depth drop off 12 pause for 2 secs in the power position': 'Depth drop off 12", pause 2 s in the power position',
       'Squat jumps w pause in landing': 'Squat jumps with pause in landing',
       'Single Leg RDL w DB': 'Single leg RDL with DB', 'Dowel power Jerk': 'Dowel power jerk',
       'BB Pressing bench': 'Bench Press', 'Ecc reclining rows chest to bar': 'Eccentric reclining rows, chest to bar',
       'BN Jerk': 'Behind-the-neck jerk', 'Pause in the Hole Snatch': 'Pause in the Hole Snatch',
       'Single Leg IsoMax': 'Single Leg Iso Max', "Dane's Platform: Miracle Gro": 'Miracle Gro',
       'Half kneeling DB': 'Half kneeling DB overhead press', 'Standing DB military': 'Standing DB military press',
       'Chun Push Press in Training': 'Chun Push Press', 'Behind Neck Jerk': 'Behind-the-neck jerk',
       'Banded Lat Swings Knees Back': 'Banded Lat Swings, Knees Back', 'BB bench press': 'Bench Press'}
def clean(t):
    t = re.sub(r'^(Garage Strength )?Movement (Library|LIbrary|s):\s*', '', t, flags=re.I)
    t = re.sub(r'^Garage Strength Movements:\s*', '', t)
    t = re.sub(r'^(How To|How to Implement the|Learn to Keep Ground Contact with the|Improve .*? with( the)?|Strengthen .*? with the)\s+', '', t)
    t = re.sub(r'\s+in Training$', '', t)
    for _ in range(2): t = re.sub(SUFFIX, '', t, flags=re.I)
    t = re.sub(r'\s+', ' ', t).strip()
    return FIX.get(t, t)

# (category, app family or None, pattern) — first match wins, so specific rules go first.
RULES = [
 ('Mobility & breathing', None, r'breathing|pvc (pipe walks|rolling)|barefoot|open the road|charleston|leg sweep|lat swings|glides'),
 ('Feet, shins & calves', 'fam-calves', r'calf|tibialis|toe curl'),
 ('Olympic pulls', 'fam-clean', r'pull(s)?( big shrug| pause| to target)?$|clean pull|snatch pull|hamstring pulls|taipei|dimas|floating'),
 ('Snatch variations', None, r'snatch(?!.*(press|rdl|external|grip push))'),
 ('Clean variations', 'fam-clean', r'clean|tall clean'),
 ('Jerk & push press', None, r'jerk|push press|press in split|establish foot'),
 ('Overhead press', None, r'z press|snatch press|military|overhead|ovh|scott press|t-press|snatch grip push press|curl and press'),
 ('Jumps & plyometrics', 'fam-jumps', r'jump|bound|hop|depth drop|hurdle|stride|gwiz jumps|slider bounds|iso ?max|overspeed'),
 ('Hamstrings & glute-ham', 'fam-hams', r'glute ham|hamstring|perturbation|reverse hyper|rdl|stiff leg|good morning|butt taps|back extension|lasha|telle|homers|hip hinge|swing'),
 ('Single-leg squat & lunge', 'fam-squat', r'lunge|split squat|single leg squat|skater|step ?ups?|cossack|bulgarian|3 way'),
 ('Squat', 'fam-squat', r'squat'),
 ('Horizontal press & push-ups', 'fam-incline', r'bench|push[- ]?ups?|push up|dips|press forward|standing flies|pipe push'),
 ('Dip', 'fam-dip', r'^dips$'),
 ('Vertical pull', 'fam-vpull', r'chin|pull ups|pull-ups|softball'),
 ('Rows', 'fam-upperback', r'row|hater|push/pull'),
 ('Biceps', 'fam-arms', r'curl(?!.*wrist)|underhook'),
 ('Triceps', 'fam-arms', r'tricep|french press|extension(?!.*(back|rotation|front headlock))|seated barbell'),
 ('Forearms & grip', None, r'forearm|wrist|roller|wheel curls|pinch|clamp'),
 ('Shoulders & upper back', 'fam-upperback', r"y'?s|t's|w's|u to t|raise(s)?$|delt|trap|external rotation|pull aparts|blackbird|high on sides|headlock|bicycling|rotations?$"),
 ('Hips & glutes', None, r'groin|side leg raise|band walks|banded marches|knees back|glute|side band'),
 ('Core', 'fam-core', r'abs?\b|plank|pallof|leg raise|twist|crunch|flexion|med ?ball|ab wheel|discus|v ups|meadow|zombie'),
]
OVERRIDE = {  # names the rules get wrong
 'Zombie Squats': 'Squat', 'Zombie squat': 'Squat', 'Dowel zombie squat': 'Squat',
 'Snatch Grip RDL': 'Hamstrings & glute-ham', 'Snatch Grip External Rotation': 'Shoulders & upper back',
 'Jerk Box Good Mornings': 'Hamstrings & glute-ham', 'Snatch Grip Push Press': 'Jerk & push press',
 'Side Plank Rows': 'Core', 'Side Plank Glute Raise': 'Hips & glutes', 'Hanging Side Leg Raise': 'Core',
 'Banded Side Leg Raise': 'Hips & glutes', 'Back Supported Leg Raise': 'Core',
 'Banded Front Headlock Extension': 'Shoulders & upper back', 'Weighted One Arm Bicycling': 'Shoulders & upper back',
 'Banded Lat Swings Knees Back': 'Mobility & breathing', 'Lat Swings': 'Mobility & breathing',
 'Banded Back Extension': 'Hamstrings & glute-ham', 'Glute Snakes': 'Hips & glutes',
 'Meadow Swings': 'Core', 'Banded Kettlebell Swing': 'Hamstrings & glute-ham', 'Kettlebell Swings': 'Hamstrings & glute-ham',
 'Pallof Split Squat': 'Core', 'Pallof Russian Lunge': 'Core', 'Pallof V-Ups': 'Core',
 'Banded Split Squat / Iso Lunge Hold': 'Single-leg squat & lunge', 'Rolling Tricep Push-Ups': 'Triceps',
 'Push/Pull': 'Shoulders & upper back', 'Wheel Curls': 'Forearms & grip', 'Clamp Curls': 'Forearms & grip',
 'Pinch Curls': 'Forearms & grip', 'Lying Barbell Flexion': 'Core', 'Chinese Plate Twists': 'Core',
 'Kneeling Side Med Ball Throws': 'Core', 'MedBall Gauntlet': 'Core', 'Discus Hold': 'Core',
 'Chest Supported Barbell Raise': 'Shoulders & upper back', 'Chest Supported Arc Row': 'Rows',
 'Banded Twist Knee Down': 'Core', 'Double Banded Twist': 'Core', 'Walking Barbell Twists': 'Core',
 'Dead Stop Power Clean and Jerk': 'Clean variations', 'Curl and Press': 'Overhead press',
 'Lean Away Tricep Extension': 'Triceps', 'Seated Barbell Extension': 'Triceps',
 'Banded Incline Tricep Extension': 'Triceps', 'Chest Supported Tricep Extension': 'Triceps',
 'Snatch Balance/Snatch': 'Snatch variations', 'Single Leg Iso Max': 'Single-leg squat & lunge',
 'Leg Raise with Plate': 'Core', 'Weighted Hanging Leg Raises': 'Core', 'Standing Ab Wheel': 'Core',
 'Banded Ab Wheel': 'Core', 'Champion Strides': 'Jumps & plyometrics', 'Band Pull Aparts': 'Shoulders & upper back',
 'Trap Raise': 'Shoulders & upper back', 'Banded Leg Sweep': 'Hips & glutes', 'Banded Glides': 'Hips & glutes',
 'Plate Side Step Ups': 'Single-leg squat & lunge', 'Gorilla Push-ups': 'Horizontal press & push-ups',
 'Dips': 'Horizontal press & push-ups', 'Banded Press in Split': 'Overhead press',
 'Dowel press in split': 'Jerk & push press', 'Hamstring Pulls': 'Hamstrings & glute-ham',
 'Loaded Banded Knees Back': 'Hips & glutes', 'Miracle Gro': 'Triceps', 'Banded Marches': 'Hips & glutes',
 'Fat Grip Reverse Wrist Curls': 'Forearms & grip', 'Jules Complex': 'Squat', 'Dips': 'Dip',
 'Half kneeling DB overhead press': 'Overhead press', 'Banded Lat Swings, Knees Back': 'Mobility & breathing',
}
FAM = {c: f for c, f, _ in RULES}
FAM['Dip'] = 'fam-dip'
for c in ('Olympic pulls', 'Horizontal press & push-ups'): FAM[c] = None

def equip(n):
    n = n.lower(); out = []
    for k, ws in [('barbell', [r'bb', 'barbell', 'snatch', 'clean', 'jerks?', 'push press', 'rdl', 'bench press', 'back squat', 'z press', 't-press', 'good mornings?', 'driver', 'french press', 'bench']),
                  ('dumbbells', ['db', 'dumbbell', 'goblet', 'concentration curl', 'hammer', 'slam curls', 'drag curls', 'hoerbel curls']),
                  ('kettlebell', ['kettle-?bell']), ('bands', ['band', 'bands', 'banded']), ('dowel', ['dowel', 'pvc', 'pipe']),
                  ('box', ['box', 'boxes', 'step[- ]?ups?']), ('cable', ['cable']), ('rings', ['ring', 'reclining']),
                  ('glute-ham', ['glute ham', 'y’s on glute']), ('pullup-bar', ['chin ups', 'pull ups', 'hanging', 'softball']),
                  ('ab-wheel', ['ab wheel']), ('med-ball', ['med ball', 'medball']), ('plate', ['plate']),
                  ('sliders', ['slider', 'sliding']), ('hurdle', ['hurdles?']), ('fat-grip', ['fat grip', 'fat bar'])]:
        if any(re.search(rf'\b{w}\b', n) for w in ws): out.append(k)
    if 'barbell' in out and any(x in out for x in ('dowel', 'dumbbells', 'bands')) and not re.search(r'\b(bb|barbell)\b', n): out.remove('barbell')
    if 'bench' in n and 'db' in n: out = ['dumbbells', 'bench'] if 'barbell' not in out else out
    return out

seen, by = set(), {}
for e in d['entries']:
    if e['id'] in seen or e['id'] in SKIP: continue
    seen.add(e['id'])
    name = clean(e['title'])
    name = name[0].upper() + name[1:]
    cat = OVERRIDE.get(name)
    if not cat:
        cat = next((c for c, _, p in RULES if re.search(p, name, re.I)), 'Uncategorised')
    key = re.sub(r'[^a-z0-9]', '', name.lower()).rstrip('s')
    v = {'url': f"https://www.youtube.com/watch?v={e['id']}", 'seconds': e.get('duration'), 'title': e['title']}
    if key in by: by[key]['videos'].append(v); continue
    by[key] = {'name': name, 'category': cat, 'appFamily': FAM.get(cat), 'equipment': equip(name), 'videos': [v]}
items = list(by.values())
order = [c for c, _, _ in RULES]
items.sort(key=lambda i: (order.index(i['category']) if i['category'] in order else 99, i['name'].lower()))
json.dump({'source': 'https://www.youtube.com/playlist?list=PLuV8B5eKhJBxZLxBmmu5TvZ50eKDS-qLd',
           'playlist': d.get('title'), 'channel': d.get('uploader'), 'fetched': '2026-10-13',
           'exercises': items}, open(sys.argv[2], 'w'), indent=1, ensure_ascii=False)
for i in items: print(f"{i['category'][:24]:24} | {i['name']:50} | {','.join(i['equipment']):22} | {len(i['videos'])}")
