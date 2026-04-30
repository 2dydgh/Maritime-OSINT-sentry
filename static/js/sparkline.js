// ── OVERWATCH 4D — Sparkline & Mini Bar Chart Renderer ──

var BottomBar = (function() {
    // Circular buffers for sparkline data
    var buffers = {
        satellites: { data: [], max: 60 },
        wind: { data: [], max: 60 },
        wave: { data: [], max: 60 }
    };

    // Vessel type counts
    var vesselCounts = {};
    // Risk level counts
    var riskCounts = { danger: 0, warning: 0, caution: 0 };

    // Risk total history (circular buffer, 60 entries ≈ 10 min at 10s interval)
    var riskHistory = [];
    var RISK_HISTORY_MAX = 60;

    var _sparklineTimers = {};
    function pushData(key, value) {
        var buf = buffers[key];
        if (!buf) return;
        buf.data.push(value);
        if (buf.data.length > buf.max) buf.data.shift();
        // Debounce sparkline render — batch rapid updates
        if (!_sparklineTimers[key]) {
            _sparklineTimers[key] = requestAnimationFrame(function() {
                _sparklineTimers[key] = null;
                renderSparkline(key);
            });
        }
    }

    function renderSparkline(key) {
        var svg = document.getElementById('spark' + key.charAt(0).toUpperCase() + key.slice(1));
        if (!svg) return;
        var data = buffers[key].data;
        if (data.length < 2) return;

        var w = 60, h = 24;
        var min = Math.min.apply(null, data);
        var max = Math.max.apply(null, data);
        var range = max - min || 1;

        var points = data.map(function(v, i) {
            var x = (i / (data.length - 1)) * w;
            var y = h - ((v - min) / range) * (h - 4) - 2;
            return x.toFixed(1) + ',' + y.toFixed(1);
        });

        var pathD = 'M' + points.join(' L');
        var fillD = pathD + ' L' + w + ',' + h + ' L0,' + h + 'Z';

        svg.innerHTML =
            '<defs><linearGradient id="sg-' + key + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="var(--secondary)" stop-opacity="0.3"/>' +
            '<stop offset="100%" stop-color="var(--secondary)" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            '<path d="' + fillD + '" fill="url(#sg-' + key + ')"/>' +
            '<path d="' + pathD + '" fill="none" stroke="var(--secondary)" stroke-width="1.2" opacity="0.6"/>';
    }

    function updateVesselTypes(counts) {
        vesselCounts = counts;
        var container = document.getElementById('vesselTreemap');
        if (!container) return;

        var defaultColors = {
            cargo: '#3b82f6', tanker: '#f97316', passenger: '#a855f7',
            fishing: '#10b981', military: '#ef4444', tug: '#06b6d4', other: '#6b7280'
        };
        var types = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];

        var items = [];
        var total = 0;
        types.forEach(function(t) {
            var v = counts[t] || 0;
            if (t === 'other') v += (counts.yacht || 0);
            total += v;
            if (v > 0) {
                var c = (typeof SHIP_COLORS !== 'undefined' && SHIP_COLORS[t]) || defaultColors[t];
                items.push({ type: t, count: v, color: c });
            }
        });
        if (total === 0) { container.innerHTML = ''; return; }

        // Sort descending by count for treemap layout
        items.sort(function(a, b) { return b.count - a.count; });

        var typeLabels = {
            cargo: 'CRG', tanker: 'TNK', passenger: 'PAX',
            fishing: 'FSH', military: 'MIL', tug: 'TUG', other: 'OTH'
        };

        var html = '';
        items.forEach(function(item) {
            var flex = Math.max(item.count / total * 10, 0.8).toFixed(2);
            var abbr = typeLabels[item.type] || item.type.substring(0, 3).toUpperCase();
            var label = item.count >= 3 ? abbr + ' ' + item.count : (item.count >= 1 ? '' + item.count : '');
            html += '<div class="treemap-cell" style="flex:' + flex + ';background:' + item.color + ';" title="' + item.type + ': ' + item.count + '">' + label + '</div>';
        });
        container.innerHTML = html;
    }

    function updateAircraftTypes(acList) {
        var container = document.getElementById('aircraftTreemap');
        if (!container) return;

        var counts = {};
        AIRCRAFT_TYPES.forEach(function(t) { counts[t] = 0; });
        acList.forEach(function(ac) {
            var type = ac.category || 'other';
            if (counts[type] !== undefined) counts[type]++;
            else counts['other']++;
        });

        var items = [];
        var total = 0;
        AIRCRAFT_TYPES.forEach(function(t) {
            var v = counts[t] || 0;
            total += v;
            if (v > 0) items.push({ type: t, count: v, color: AIRCRAFT_COLORS[t] || '#9ca3af' });
        });
        if (total === 0) { container.innerHTML = ''; return; }

        items.sort(function(a, b) { return b.count - a.count; });

        var acLabels = { civilian: 'CIV', military: 'MIL', helicopter: 'HEL', other: 'OTH' };
        var html = '';
        items.forEach(function(item) {
            var flex = Math.max(item.count / total * 10, 0.8).toFixed(2);
            var abbr = acLabels[item.type] || 'OTH';
            var label = item.count >= 3 ? abbr + ' ' + item.count : (item.count >= 1 ? '' + item.count : '');
            html += '<div class="treemap-cell" style="flex:' + flex + ';background:' + item.color + ';" title="' + item.type + ': ' + item.count + '">' + label + '</div>';
        });
        container.innerHTML = html;
    }

    function updateRiskLevels(danger, warning, caution) {
        riskCounts = { danger: danger, warning: warning, caution: caution };
        var total = danger + warning + caution;

        // Push to history buffer
        riskHistory.push(total);
        if (riskHistory.length > RISK_HISTORY_MAX) riskHistory.shift();

        // Update value display
        var valEl = document.getElementById('bottomRisk');
        if (valEl) {
            var unit = valEl.querySelector('.stat-card-unit');
            var unitText = unit ? unit.outerHTML : '';
            valEl.innerHTML = total + unitText;
        }

        // Update sea area bar chart
        updateRiskAreaBars();
    }

    var _prevAreaCounts = {};

    function updateRiskAreaBars() {
        var el = document.getElementById('riskAreaBars');
        if (!el) return;

        var mlRisks = (typeof collisionData !== 'undefined' && collisionData.ml && collisionData.ml.risks) || [];
        if (mlRisks.length === 0) {
            el.innerHTML = '<span style="font-size:0.65rem;color:var(--text-sub);">위험 없음</span>';
            _prevAreaCounts = {};
            return;
        }

        // Count by sea area
        var areaCounts = {};
        mlRisks.forEach(function(r) {
            var midLat = (r.ship_a.lat + r.ship_b.lat) / 2;
            var midLng = (r.ship_a.lng + r.ship_b.lng) / 2;
            var name = typeof getSeaAreaName === 'function' ? getSeaAreaName(midLat, midLng) : '기타';
            areaCounts[name] = (areaCounts[name] || 0) + 1;
        });

        // Sort by count desc, show all
        var sorted = Object.keys(areaCounts).sort(function(a, b) { return areaCounts[b] - areaCounts[a]; });

        el.innerHTML = sorted.map(function(name) {
            var count = areaCounts[name];
            var changed = _prevAreaCounts[name] !== count;
            return '<span class="risk-area-tag">' + name + ' <b class="' + (changed ? 'updated' : '') + '">' + count + '</b></span>';
        }).join('');

        // Re-trigger animation on changed counts
        if (el.querySelectorAll) {
            el.querySelectorAll('b.updated').forEach(function(b) {
                b.addEventListener('animationend', function() { b.classList.remove('updated'); }, { once: true });
            });
        }

        _prevAreaCounts = areaCounts;
    }

    function updateValue(id, value) {
        var el = document.getElementById(id);
        if (el) {
            var unit = el.querySelector('.stat-card-unit');
            var unitText = unit ? unit.outerHTML : '';
            el.innerHTML = value + unitText;
        }
    }

    // FLAG — country count only (detail in popup)
    var FLAG_COLORS = ['#3b82f6', '#60a5fa', '#93bbfd', '#bdd4fe', '#dbeafe', '#94a3b8', '#64748b'];

    function updateFlagDistribution(vessels) {
        var countEl = document.getElementById('bottomFlagCount');
        var emojiEl = document.getElementById('flagEmojis');

        var countryMap = {};
        vessels.forEach(function(v) {
            var c = v.country || v.flag || '';
            if (!c) return;
            if (!countryMap[c]) countryMap[c] = 0;
            countryMap[c]++;
        });

        var keys = Object.keys(countryMap);
        if (countEl) countEl.textContent = keys.length;

        if (emojiEl) {
            var top5 = keys.sort(function(a, b) { return countryMap[b] - countryMap[a]; }).slice(0, 5);
            emojiEl.innerHTML = top5.map(function(name) { return _countryFlagHTML(name); }).filter(Boolean).join(' ');
        }
    }

    // ── Detail Popup ──
    var _activePopup = null;
    var _lastVessels = [];

    function _storeVessels(vessels) {
        _lastVessels = vessels;
    }

    var defaultColors = {
        cargo: '#3b82f6', tanker: '#f97316', passenger: '#a855f7',
        fishing: '#10b981', military: '#ef4444', tug: '#06b6d4', other: '#6b7280'
    };

    var typeLabelsLong = {
        cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger',
        fishing: 'Fishing', military: 'Military', tug: 'Tug/Pilot', other: 'Other'
    };

    function showDetail(cardId) {
        var popup = document.getElementById('bottomDetailPopup');
        if (!popup) return;

        // Toggle off if same card
        if (_activePopup === cardId) {
            closeDetail();
            return;
        }

        // Remove active from all cards
        var cards = document.querySelectorAll('.stat-card, .bottom-stat');
        cards.forEach(function(c) { c.classList.remove('active'); });

        var card = document.getElementById(cardId);
        if (card) card.classList.add('active');

        var html = '';

        if (cardId === 'statRisk') {
            html = _buildRiskDetail();
        } else if (cardId === 'statWind' || cardId === 'statWave') {
            html = _buildWindWaveDetail();
        } else if (cardId === 'statFlag') {
            html = _buildFlagDetail();
        }

        popup.innerHTML = html;
        popup.classList.add('visible');
        _activePopup = cardId;

        // Position popup above the clicked card (after layout)
        if (card) {
            requestAnimationFrame(function() {
                var cardRect = card.getBoundingClientRect();
                var popupRect = popup.getBoundingClientRect();
                var parent = popup.offsetParent || document.body;
                var parentRect = parent.getBoundingClientRect();
                var popupWidth = popupRect.width;
                // Align left edge of popup to left edge of card
                var desiredLeft = cardRect.left - parentRect.left;
                // Check for nav controls overlap (left ~160px zone)
                var navControls = document.getElementById('mapNavControls');
                var minLeft = 8;
                if (navControls && navControls.offsetParent !== null) {
                    var navRect = navControls.getBoundingClientRect();
                    minLeft = navRect.right - parentRect.left + 12;
                }
                desiredLeft = Math.max(minLeft, desiredLeft);
                // Clamp right edge within parent
                var maxLeft = parentRect.width - popupWidth - 8;
                desiredLeft = Math.min(desiredLeft, maxLeft);
                popup.style.left = desiredLeft + 'px';
            });
        }

        // Close button handler
        var closeBtn = popup.querySelector('.detail-close');
        if (closeBtn) closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            closeDetail();
        });
    }

    function closeDetail() {
        var popup = document.getElementById('bottomDetailPopup');
        if (popup) popup.classList.remove('visible');
        var cards = document.querySelectorAll('.stat-card, .bottom-stat');
        cards.forEach(function(c) { c.classList.remove('active'); });
        _activePopup = null;
    }

    function _detailHeader(title) {
        return '<div class="detail-header"><span class="detail-title">' + title + '</span>' +
            '<button class="detail-close"><i class="fa-solid fa-xmark"></i></button></div>';
    }

    function _buildVesselDetail() {
        var types = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];
        var total = 0;
        types.forEach(function(t) {
            var v = vesselCounts[t] || 0;
            if (t === 'other') v += (vesselCounts.yacht || 0);
            total += v;
        });

        var html = _detailHeader('선종별 선박 — ' + total + '척');
        html += '<div class="detail-grid">';
        types.forEach(function(t) {
            var v = vesselCounts[t] || 0;
            if (t === 'other') v += (vesselCounts.yacht || 0);
            var color = (typeof SHIP_COLORS !== 'undefined' && SHIP_COLORS[t]) || defaultColors[t];
            var pct = total > 0 ? (v / total * 100).toFixed(1) : '0.0';
            html += '<div class="detail-item">' +
                '<div class="detail-color" style="background:' + color + ';"></div>' +
                '<span class="detail-label">' + (typeLabelsLong[t] || t) + '</span>' +
                '<span class="detail-value">' + v + '</span>' +
                '<span class="detail-pct">' + pct + '%</span>' +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function _buildRiskDetail() {
        var total = riskCounts.danger + riskCounts.warning + riskCounts.caution;
        var html = _detailHeader('해역별 위험 현황 — ' + total + '건');

        // Level summary
        html += '<div class="detail-grid">';
        var levels = [
            { key: 'danger', label: '위험', color: '#ef4444' },
            { key: 'warning', label: '경고', color: '#fb923c' },
            { key: 'caution', label: '주의', color: '#eab308' }
        ];
        levels.forEach(function(lv) {
            var v = riskCounts[lv.key] || 0;
            var pct = total > 0 ? (v / total * 100).toFixed(1) : '0.0';
            html += '<div class="detail-item">' +
                '<div class="detail-color" style="background:' + lv.color + ';"></div>' +
                '<span class="detail-label">' + lv.label + '</span>' +
                '<span class="detail-value">' + v + '</span>' +
                '<span class="detail-pct">' + pct + '%</span>' +
                '</div>';
        });
        html += '</div>';

        // Sea area breakdown
        var mlRisks = (typeof collisionData !== 'undefined' && collisionData.ml && collisionData.ml.risks) || [];
        if (mlRisks.length > 0) {
            var areaBreakdown = {};
            mlRisks.forEach(function(r) {
                var midLat = (r.ship_a.lat + r.ship_b.lat) / 2;
                var midLng = (r.ship_a.lng + r.ship_b.lng) / 2;
                var name = typeof getSeaAreaName === 'function' ? getSeaAreaName(midLat, midLng) : '기타';
                if (!areaBreakdown[name]) areaBreakdown[name] = { danger: 0, warning: 0, caution: 0, total: 0 };
                if (r.risk_level === 3) areaBreakdown[name].danger++;
                else if (r.risk_level === 2) areaBreakdown[name].warning++;
                else areaBreakdown[name].caution++;
                areaBreakdown[name].total++;
            });

            var sortedAreas = Object.keys(areaBreakdown).sort(function(a, b) {
                return areaBreakdown[b].total - areaBreakdown[a].total;
            });

            html += '<div class="detail-section-title">해역별 현황</div>';
            sortedAreas.forEach(function(name) {
                var a = areaBreakdown[name];
                html += '<div class="detail-area-row">' +
                    '<span class="detail-area-name">' + name + '</span>' +
                    '<span class="detail-area-counts">';
                if (a.danger > 0) html += '<span style="color:#ef4444;">' + a.danger + '위험</span> ';
                if (a.warning > 0) html += '<span style="color:#fb923c;">' + a.warning + '경고</span> ';
                if (a.caution > 0) html += '<span style="color:#eab308;">' + a.caution + '주의</span>';
                html += '</span>' +
                    '<span class="detail-area-total">' + a.total + '</span>' +
                    '</div>';
            });
        }

        return html;
    }

    function _buildWindWaveDetail() {
        var html = _detailHeader('풍속·파고 — 전역 최대값');

        var wxData = (typeof _wxData !== 'undefined') ? _wxData : {};
        var windPoints = (wxData.wind && wxData.wind.points) || [];
        var marinePoints = (wxData.marine && wxData.marine.points) || [];

        // Find top 3 wind
        var topWind = windPoints.slice().sort(function(a, b) {
            return (b.wind_speed || 0) - (a.wind_speed || 0);
        }).slice(0, 3);

        // Find top 3 wave
        var topWave = marinePoints.slice().sort(function(a, b) {
            return (b.wave_height || 0) - (a.wave_height || 0);
        }).slice(0, 3);

        html += '<div class="detail-section-title">Wind — Top 3</div>';
        html += '<div class="detail-grid">';
        topWind.forEach(function(p, i) {
            var region = (typeof _oceanRegionName === 'function') ? _oceanRegionName(p.lat, p.lon) : '';
            var coord = Math.abs(p.lat).toFixed(0) + '°' + (p.lat >= 0 ? 'N' : 'S') + ' ' +
                Math.abs(p.lon).toFixed(0) + '°' + (p.lon >= 0 ? 'E' : 'W');
            html += '<div class="detail-item" style="flex-direction:column;align-items:flex-start;gap:2px;">' +
                '<div style="display:flex;align-items:baseline;gap:4px;">' +
                '<span class="detail-wx-val">' + (p.wind_speed || 0).toFixed(1) + '</span>' +
                '<span class="detail-wx-unit">kt</span></div>' +
                '<span class="detail-wx-loc">' + (region ? region + ' ' : '') + coord + '</span>' +
                '</div>';
        });
        html += '</div>';

        html += '<div class="detail-section-title">Wave — Top 3</div>';
        html += '<div class="detail-grid">';
        topWave.forEach(function(p, i) {
            var region = (typeof _oceanRegionName === 'function') ? _oceanRegionName(p.lat, p.lon) : '';
            var coord = Math.abs(p.lat).toFixed(0) + '°' + (p.lat >= 0 ? 'N' : 'S') + ' ' +
                Math.abs(p.lon).toFixed(0) + '°' + (p.lon >= 0 ? 'E' : 'W');
            html += '<div class="detail-item" style="flex-direction:column;align-items:flex-start;gap:2px;">' +
                '<div style="display:flex;align-items:baseline;gap:4px;">' +
                '<span class="detail-wx-val">' + (p.wave_height || 0).toFixed(1) + '</span>' +
                '<span class="detail-wx-unit">m</span></div>' +
                '<span class="detail-wx-loc">' + (region ? region + ' ' : '') + coord + '</span>' +
                '</div>';
        });
        html += '</div>';

        return html;
    }

    // Country name → ISO 2-letter code
    var COUNTRY_ISO = {
        'Albania':'AL','Andorra':'AD','Austria':'AT','Portugal':'PT','Belgium':'BE',
        'Belarus':'BY','Bulgaria':'BG','Vatican':'VA','Cyprus':'CY','Germany':'DE',
        'Georgia':'GE','Moldova':'MD','Malta':'MT','Armenia':'AM','Denmark':'DK',
        'Spain':'ES','France':'FR','Finland':'FI','Faroe Islands':'FO',
        'United Kingdom':'GB','Gibraltar':'GI','Greece':'GR','Croatia':'HR',
        'Morocco':'MA','Hungary':'HU','Netherlands':'NL','Italy':'IT','Ireland':'IE',
        'Iceland':'IS','Liechtenstein':'LI','Luxembourg':'LU','Monaco':'MC',
        'Norway':'NO','Poland':'PL','Romania':'RO','Sweden':'SE','Slovakia':'SK',
        'San Marino':'SM','Switzerland':'CH','Czech Republic':'CZ','Turkey':'TR',
        'Ukraine':'UA','Russia':'RU','North Macedonia':'MK','Latvia':'LV',
        'Estonia':'EE','Lithuania':'LT','Slovenia':'SI',
        'Anguilla':'AI','Alaska':'US','Antigua':'AG','Bahamas':'BS','Bermuda':'BM',
        'Belize':'BZ','Barbados':'BB','Canada':'CA','Cayman Islands':'KY',
        'Costa Rica':'CR','Cuba':'CU','Dominica':'DM','Dominican Republic':'DO',
        'Grenada':'GD','Greenland':'GL','Guatemala':'GT','Honduras':'HN','Haiti':'HT',
        'United States':'US','Jamaica':'JM','Saint Kitts':'KN','Saint Lucia':'LC',
        'Mexico':'MX','Nicaragua':'NI','Panama':'PA','Puerto Rico':'PR',
        'El Salvador':'SV','Trinidad':'TT','Turks and Caicos':'TC',
        'Saint Vincent':'VC','British Virgin Islands':'VG','US Virgin Islands':'VI',
        'Afghanistan':'AF','Saudi Arabia':'SA','Bangladesh':'BD','Bahrain':'BH',
        'Bhutan':'BT','China':'CN','Taiwan':'TW','Sri Lanka':'LK','India':'IN',
        'Iran':'IR','Azerbaijan':'AZ','Iraq':'IQ','Israel':'IL','Japan':'JP',
        'Turkmenistan':'TM','Kazakhstan':'KZ','Uzbekistan':'UZ','Jordan':'JO',
        'South Korea':'KR','North Korea':'KP','Kuwait':'KW','Lebanon':'LB',
        'Kyrgyzstan':'KG','Macao':'MO','Maldives':'MV','Mongolia':'MN','Nepal':'NP',
        'Oman':'OM','Pakistan':'PK','Qatar':'QA','Syria':'SY','UAE':'AE',
        'Tajikistan':'TJ','Yemen':'YE','Tonga':'TO','Hong Kong':'HK','Bosnia':'BA',
        'Australia':'AU','Myanmar':'MM','Brunei':'BN','New Zealand':'NZ',
        'Cambodia':'KH','Fiji':'FJ','Indonesia':'ID','Kiribati':'KI','Laos':'LA',
        'Malaysia':'MY','Marshall Islands':'MH','Micronesia':'FM','Palau':'PW',
        'Philippines':'PH','Papua New Guinea':'PG','Singapore':'SG','Thailand':'TH',
        'Tuvalu':'TV','Vietnam':'VN','Vanuatu':'VU','Samoa':'WS',
        'South Africa':'ZA','Angola':'AO','Algeria':'DZ','Benin':'BJ','Botswana':'BW',
        'Burundi':'BI','Cameroon':'CM','Cape Verde':'CV','Central African Republic':'CF',
        'Congo':'CG','Comoros':'KM','DR Congo':'CD','Ivory Coast':'CI','Djibouti':'DJ',
        'Egypt':'EG','Equatorial Guinea':'GQ','Ethiopia':'ET','Eritrea':'ER',
        'Gabon':'GA','Gambia':'GM','Ghana':'GH','Guinea':'GN','Guinea-Bissau':'GW',
        'Kenya':'KE','Lesotho':'LS','Liberia':'LR','Libya':'LY','Madagascar':'MG',
        'Malawi':'MW','Mali':'ML','Mauritania':'MR','Mauritius':'MU','Mozambique':'MZ',
        'Namibia':'NA','Niger':'NE','Nigeria':'NG','Rwanda':'RW','Senegal':'SN',
        'Sierra Leone':'SL','Somalia':'SO','Sudan':'SD','Tanzania':'TZ','Togo':'TG',
        'Tunisia':'TN','Uganda':'UG','Zambia':'ZM','Zimbabwe':'ZW',
        'Antarctica':'AQ','Niue':'NU','Nauru':'NR','Solomon Islands':'SB',
        'Pitcairn':'PN','American Samoa':'AS','Cook Islands':'CK',
        'Christmas Island':'CX','Cocos Islands':'CC','New Caledonia':'NC',
        'French Polynesia':'PF','Northern Mariana Islands':'MP',
        'Wallis and Futuna':'WF','Saint Pierre':'PM','Guadeloupe':'GP',
        'Martinique':'MQ','Montserrat':'MS','Aruba':'AW','Netherlands Antilles':'AN'
    };

    // Convert country name or 2-letter code to ISO
    function _countryToISO(name) {
        if (!name || name === 'UNKNOWN') return '';
        if (name.length === 2) return name.toUpperCase();
        if (COUNTRY_ISO[name]) return COUNTRY_ISO[name];
        var lower = name.toLowerCase();
        for (var key in COUNTRY_ISO) {
            if (key.toLowerCase() === lower) return COUNTRY_ISO[key];
        }
        return '';
    }

    // Return flag icon HTML using flag-icons CSS
    function _countryFlagHTML(name) {
        var iso = _countryToISO(name);
        if (!iso) return '';
        return '<span class="fi fi-' + iso.toLowerCase() + '"></span>';
    }

    function _buildFlagDetail() {
        var countryMap = {};
        var totalShips = 0;
        _lastVessels.forEach(function(v) {
            var c = v.country || v.flag || '';
            if (!c) return;
            if (!countryMap[c]) countryMap[c] = 0;
            countryMap[c]++;
            totalShips++;
        });

        var sorted = Object.keys(countryMap).map(function(k) {
            return { code: k, count: countryMap[k] };
        }).sort(function(a, b) { return b.count - a.count; });

        var html = _detailHeader('선적국 분포 — ' + sorted.length + '개국');
        html += '<div class="detail-grid">';
        sorted.forEach(function(item, i) {
            var flag = _countryFlagHTML(item.code);
            var pct = totalShips > 0 ? (item.count / totalShips * 100).toFixed(1) : '0.0';
            html += '<div class="detail-item">' +
                (flag ? flag + ' ' : '') +
                '<span class="detail-label">' + item.code + '</span>' +
                '<span class="detail-value">' + item.count + '</span>' +
                '<span class="detail-pct">' + pct + '%</span>' +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    // Bind click events
    document.addEventListener('DOMContentLoaded', function() {
        ['statRisk', 'statWind', 'statWave', 'statFlag'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', function() { showDetail(id); });
        });

        // Close on click outside
        document.addEventListener('click', function(e) {
            if (!_activePopup) return;
            var popup = document.getElementById('bottomDetailPopup');
            var bar = document.getElementById('bottomBar');
            if (popup && !popup.contains(e.target) && bar && !bar.contains(e.target)) {
                closeDetail();
            }
        });
    });

    return {
        pushData: pushData,
        updateVesselTypes: updateVesselTypes,
        updateAircraftTypes: updateAircraftTypes,
        updateRiskLevels: updateRiskLevels,
        updateValue: updateValue,
        updateFlagDistribution: updateFlagDistribution,
        showDetail: showDetail,
        closeDetail: closeDetail,
        _storeVessels: _storeVessels
    };
})();

window.BottomBar = BottomBar;
