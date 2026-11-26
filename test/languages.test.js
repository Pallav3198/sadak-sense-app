// Spec 14.7: written-sentence tests in every language the driver can use. The rule-based brain is the
// offline fallback, so it must understand these without any network. (Spoken tests by native speakers
// are a separate, manual step.)
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../web/shared/hinglish.js");

const CASES = {
  English: { ahead: "Is there any pothole ahead?", water: "Is the underpass flooded?", report: "There is a pothole here", car: "Will my car make it?", yes: "yes", no: "no" },
  Hinglish: { ahead: "Aage koi gaddha hai?", water: "Underpass mein paani hai kya?", report: "Yahan bada gaddha hai", car: "Meri gaadi nikal jayegi?", yes: "haan", no: "nahi" },
  Hindi: { ahead: "आगे कोई गड्ढा है?", water: "अंडरपास में पानी है क्या?", report: "यहाँ गड्ढा है", car: "मेरी गाड़ी निकल जाएगी?", yes: "हाँ", no: "नहीं" },
  Tamil: { ahead: "முன்னால் பள்ளம் இருக்கா?", water: "அண்டர்பாஸில் தண்ணீர் இருக்கா?", report: "இங்கே பள்ளம் இருக்கு", car: "என் கார் போகுமா?", yes: "ஆமா", no: "இல்லை" },
  Telugu: { ahead: "ముందు గుంత ఉందా?", water: "అండర్‌పాస్‌లో నీళ్ళు ఉన్నాయా?", report: "ఇక్కడ గుంత ఉంది", car: "నా కారు వెళ్తుందా?", yes: "అవును", no: "లేదు" },
  Malayalam: { ahead: "മുന്നിൽ കുഴി ഉണ്ടോ?", water: "അണ്ടർപാസിൽ വെള്ളം ഉണ്ടോ?", report: "ഇവിടെ കുഴി ഉണ്ട്", car: "എന്റെ കാർ പോകുമോ?", yes: "അതെ", no: "ഇല്ല" },
  Kannada: { ahead: "ಮುಂದೆ ಗುಂಡಿ ಇದೆಯಾ?", water: "ಅಂಡರ್‌ಪಾಸ್‌ನಲ್ಲಿ ನೀರು ಇದೆಯಾ?", report: "ಇಲ್ಲಿ ಗುಂಡಿ ಇದೆ", car: "ನನ್ನ ಕಾರು ಹೋಗುತ್ತಾ?", yes: "ಹೌದು", no: "ಇಲ್ಲ" },
  Bengali: { ahead: "সামনে কোনো গর্ত আছে কি?", water: "আন্ডারপাসে জল আছে কি?", report: "এখানে গর্ত আছে", car: "আমার গাড়ি যেতে পারবে?", yes: "হ্যাঁ", no: "না" },
};

for (const [lang, c] of Object.entries(CASES)) {
  test(`${lang}: the offline brain understands written sentences`, () => {
    assert.deepEqual(V.intent(c.ahead), { name: "ask_ahead", type: "pothole" }, c.ahead);
    assert.equal(V.intent(c.water).name, "ask_water", c.water);
    assert.deepEqual(V.intent(c.report), { name: "report", type: "pothole" }, c.report);
    assert.equal(V.intent(c.car).name, "ask_car", c.car);
    assert.equal(V.intent(c.yes).name, "yes", c.yes);
    assert.equal(V.intent(c.no).name, "no", c.no);
  });
}

test("other scripts: answered with live facts, spoken in the driver's language", () => {
  const r = V.reply(CASES.Tamil.ahead, { ahead: [{ type: "pothole", dist: 180, devices: 5 }] });
  assert.equal(r.voice, "Tamil"); assert.equal(r.lang, "English"); assert.match(r.reply, /180 metres/);
  assert.equal(V.detectLang(CASES.Bengali.ahead), "Bengali");
  assert.equal(V.reply(CASES.Hindi.ahead, {}).voice, null);
});
