// ==UserScript==
// @name         FarmBeast
// @namespace    https://github.com/Arikuma97/FarmBeast
// @version      2.0.3
// @description  Optimized farming planner for Tribal Wars (FarmGod fork)
// @author       Warre (optimized)
// @match        https://*.tribalwars.*/game.php*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('FarmBeast: Script loaded, waiting for game dependencies...');

    // ---------- Wait for required game objects ----------
    function waitForDependencies(callback) {
        if (typeof ScriptAPI !== 'undefined' &&
            typeof $ !== 'undefined' &&
            typeof game_data !== 'undefined' &&
            typeof UI !== 'undefined' &&
            typeof Dialog !== 'undefined' &&
            typeof TribalWars !== 'undefined' &&
            typeof Accountmanager !== 'undefined') {
            console.log('FarmBeast: Dependencies ready.');
            callback();
        } else {
            console.log('FarmBeast: Waiting...');
            setTimeout(() => waitForDependencies(callback), 300);
        }
    }

    waitForDependencies(function() {
        try {
            // ----- Register Script -----
            ScriptAPI.register('FarmBeast', true, 'Warre (optimized)', 'nl.tribalwars@coma.innogames.de');

            // ----- Namespace -----
            window.FarmBeast = window.FarmBeast || {};

            // ============================================================
            //  LIBRARY MODULE (Optimized)
            // ============================================================
            window.FarmBeast.Library = (function() {
                // ---------- twLib Queue Manager ----------
                if (typeof window.twLib === 'undefined') {
                    window.twLib = {
                        queues: null,
                        init: function() {
                            if (this.queues === null) {
                                this.queues = this.queueLib.createQueues(5);
                            }
                        },
                        queueLib: {
                            maxAttempts: 3,
                            Item: function(action, arg, promise) {
                                this.action = action;
                                this.arguments = arg;
                                this.promise = promise || null;
                                this.attempts = 0;
                            },
                            Queue: function() {
                                this.list = [];
                                this.working = false;
                                this.length = 0;

                                this.doNext = function() {
                                    var item = this.dequeue();
                                    var self = this;

                                    if (item.action === 'openWindow') {
                                        window.open.apply(window, item.arguments)
                                            .addEventListener('DOMContentLoaded', function() { self.start(); });
                                    } else {
                                        $[item.action].apply($, item.arguments)
                                            .done(function() {
                                                if (item.promise) item.promise.resolve.apply(null, arguments);
                                                self.start();
                                            })
                                            .fail(function() {
                                                item.attempts += 1;
                                                if (item.attempts < twLib.queueLib.maxAttempts) {
                                                    self.enqueue(item, true);
                                                } else {
                                                    if (item.promise) item.promise.reject.apply(null, arguments);
                                                }
                                                self.start();
                                            });
                                    }
                                };

                                this.start = function() {
                                    if (this.length) {
                                        this.working = true;
                                        this.doNext();
                                    } else {
                                        this.working = false;
                                    }
                                };

                                this.dequeue = function() {
                                    this.length -= 1;
                                    return this.list.shift();
                                };

                                this.enqueue = function(item, front) {
                                    front = front || false;
                                    front ? this.list.unshift(item) : this.list.push(item);
                                    this.length += 1;
                                    if (!this.working) this.start();
                                };
                            },
                            createQueues: function(amount) {
                                var arr = [];
                                for (var i = 0; i < amount; i++) {
                                    arr.push(new twLib.queueLib.Queue());
                                }
                                return arr;
                            },
                            addItem: function(item) {
                                var lengths = twLib.queues.map(function(q) { return q.length; });
                                var leastBusy = lengths.indexOf(Math.min.apply(null, lengths));
                                twLib.queues[leastBusy].enqueue(item);
                            },
                            orchestrator: function(type, arg) {
                                var promise = $.Deferred();
                                var item = new twLib.queueLib.Item(type, arg, promise);
                                twLib.queueLib.addItem(item);
                                return promise;
                            }
                        },
                        ajax: function() { return twLib.queueLib.orchestrator('ajax', arguments); },
                        get: function() { return twLib.queueLib.orchestrator('get', arguments); },
                        post: function() { return twLib.queueLib.orchestrator('post', arguments); },
                        openWindow: function() {
                            var item = new twLib.queueLib.Item('openWindow', arguments);
                            twLib.queueLib.addItem(item);
                        }
                    };
                    twLib.init();
                }

                // ---------- Caches ----------
                var distanceCache = new Map();
                var unitSpeedsCache = null;

                // ---------- Unit Speeds (fetched once) ----------
                function fetchUnitSpeeds() {
                    if (unitSpeedsCache) return $.Deferred().resolve(unitSpeedsCache).promise();
                    var deferred = $.Deferred();
                    $.get('/interface.php?func=get_unit_info')
                        .then(function(xml) {
                            var speeds = {};
                            $(xml).find('config').children().each(function() {
                                var unit = $(this).prop('nodeName');
                                speeds[unit] = parseFloat($(this).find('speed').text());
                            });
                            unitSpeedsCache = speeds;
                            localStorage.setItem('FarmBeast_unitSpeeds', JSON.stringify(speeds));
                            deferred.resolve(speeds);
                        })
                        .fail(function() {
                            var stored = localStorage.getItem('FarmBeast_unitSpeeds');
                            unitSpeedsCache = stored ? JSON.parse(stored) : {};
                            deferred.resolve(unitSpeedsCache);
                        });
                    return deferred.promise();
                }

                function getUnitSpeeds() {
                    return unitSpeedsCache || JSON.parse(localStorage.getItem('FarmBeast_unitSpeeds')) || false;
                }

                // ---------- Pagination Helpers ----------
                function determineNextPage(page, $html) {
                    var villageLength = $html.find('#scavenge_mass_screen').length > 0 ?
                        $html.find('tr[id*="scavenge_village"]').length :
                        $html.find('tr.row_a, tr.row_ax, tr.row_b, tr.row_bx').length;
                    var navSelect = $html.find('.paged-nav-item').first().closest('td').find('select').first();
                    var navLength;

                    if ($html.find('#am_widget_Farm').length > 0) {
                        var navItems = $('#plunder_list_nav').first().find('a.paged-nav-item, strong.paged-nav-item');
                        var lastPageText = navItems.length ? navItems[navItems.length - 1].textContent : '0';
                        navLength = parseInt(lastPageText.replace(/\D/g, '')) - 1;
                    } else if (navSelect.length > 0) {
                        navLength = navSelect.find('option').length - 1;
                    } else {
                        navLength = $html.find('.paged-nav-item').not('[href*="page=-1"]').length;
                    }

                    var pageSize = $('#mobileHeader').length > 0 ? 10 : parseInt($html.find('input[name="page_size"]').val());

                    if (page === -1 && villageLength === 1000) {
                        return Math.floor(1000 / pageSize);
                    } else if (page < navLength) {
                        return page + 1;
                    }
                    return false;
                }

                function processPage(url, page, wrapFn) {
                    var pageParam = url.indexOf('am_farm') !== -1 ? '&Farm_page=' + page : '&page=' + page;
                    return twLib.ajax({ url: url + pageParam }).then(function(html) {
                        return wrapFn(page, $(html));
                    });
                }

                function processAllPages(url, processorFn) {
                    var startPage = (url.indexOf('am_farm') !== -1 || url.indexOf('scavenge_mass') !== -1) ? 0 : -1;
                    function wrapFn(page, $html) {
                        var next = determineNextPage(page, $html);
                        if (next) {
                            processorFn($html);
                            return processPage(url, next, wrapFn);
                        } else {
                            return processorFn($html);
                        }
                    }
                    return processPage(url, startPage, wrapFn);
                }

                // ---------- Distance with Cache & Bounding Box ----------
                function getDistance(originCoord, targetCoord) {
                    var key = originCoord + '->' + targetCoord;
                    if (distanceCache.has(key)) return distanceCache.get(key);

                    var o = originCoord.split('|').map(Number);
                    var t = targetCoord.split('|').map(Number);
                    var dist = Math.hypot(t[0] - o[0], t[1] - o[1]);
                    distanceCache.set(key, dist);
                    return dist;
                }

                function isWithinBoundingBox(originCoord, targetCoord, maxDist) {
                    var o = originCoord.split('|').map(Number);
                    var t = targetCoord.split('|').map(Number);
                    return Math.abs(t[0] - o[0]) <= maxDist && Math.abs(t[1] - o[1]) <= maxDist;
                }

                function clearDistanceCache() {
                    distanceCache.clear();
                }

                // ---------- Array Subtraction ----------
                function subtractArrays(arr1, arr2) {
                    var result = new Array(arr1.length);
                    for (var i = 0; i < arr1.length; i++) {
                        result[i] = arr1[i] - arr2[i];
                        if (result[i] < 0) return false;
                    }
                    return result;
                }

                // ---------- Time Utilities ----------
                function getCurrentServerTime() {
                    var text = $('#serverTime').closest('p').text();
                    var parts = text.match(/\d+/g).map(Number);
                    return new Date(parts[5], parts[4] - 1, parts[3], parts[0], parts[1], parts[2]).getTime();
                }

                function timestampFromString(timestr) {
                    var d = $('#serverDate').text().split('/').map(function(x) { return +x; });
                    var todayRegex = new RegExp(window.lang['aea2b0aa9ae1534226518faaefffdaad'].replace('%s', '([\\d+|:]+)'));
                    var tomorrowRegex = new RegExp(window.lang['57d28d1b211fddbb7a499ead5bf23079'].replace('%s', '([\\d+|:]+)'));
                    var laterRegex = new RegExp(window.lang['0cb274c906d622fa8ce524bcfbb7552d'].replace('%1', '([\\d+|\\.]+)').replace('%2', '([\\d+|:]+)'));

                    var t, date;
                    if (todayRegex.test(timestr)) {
                        t = RegExp.$1.split(':').map(Number);
                        date = new Date(d[2], d[1] - 1, d[0], t[0], t[1], t[2] || 0);
                    } else if (tomorrowRegex.test(timestr)) {
                        t = RegExp.$1.split(':').map(Number);
                        date = new Date(d[2], d[1] - 1, d[0] + 1, t[0], t[1], t[2] || 0);
                    } else if (laterRegex.test(timestr)) {
                        var datePart = (RegExp.$1 + d[2]).split('.').map(Number);
                        t = RegExp.$2.split(':').map(Number);
                        date = new Date(datePart[2], datePart[1] - 1, datePart[0], t[0], t[1], t[2] || 0);
                    } else {
                        return Date.now();
                    }
                    return date.getTime();
                }

                // ---------- Coordinate Helpers (no prototype pollution) ----------
                function extractCoord(str) {
                    var match = str.match(/\d{1,3}\|\d{1,3}/);
                    return match ? match[0] : null;
                }

                // ---------- Public API ----------
                return {
                    fetchUnitSpeeds: fetchUnitSpeeds,
                    getUnitSpeeds: getUnitSpeeds,
                    processPage: processPage,
                    processAllPages: processAllPages,
                    getDistance: getDistance,
                    isWithinBoundingBox: isWithinBoundingBox,
                    clearDistanceCache: clearDistanceCache,
                    subtractArrays: subtractArrays,
                    getCurrentServerTime: getCurrentServerTime,
                    timestampFromString: timestampFromString,
                    extractCoord: extractCoord
                };
            })();

            // ============================================================
            //  TRANSLATION MODULE
            // ============================================================
            window.FarmBeast.Translation = (function() {
                var msg = {
                    nl_NL: {
                        missingFeatures: 'Script vereist een premium account en farm assistent!',
                        options: {
                            title: 'FarmBeast Opties',
                            warning: '<b>Waarschuwingen:</b><br>- Zorg dat A is ingesteld als je standaard microfarm en B als een grotere microfarm<br>- Zorg dat de farm filters correct zijn ingesteld voor je het script gebruikt',
                            filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters.png',
                            group: 'Uit welke groep moet er gefarmd worden:',
                            distance: 'Maximaal aantal velden dat farms mogen lopen:',
                            time: 'Hoe veel tijd in minuten moet er tussen farms zitten:',
                            losses: 'Verstuur farm naar dorpen met gedeeltelijke verliezen:',
                            maxloot: 'Verstuur een B farm als de buit vorige keer vol was:',
                            newbarbs: 'Voeg nieuwe barbarendorpen toe om te farmen:',
                            button: 'Plan farms'
                        },
                        table: {
                            noFarmsPlanned: 'Er kunnen met de opgegeven instellingen geen farms verstuurd worden.',
                            origin: 'Oorsprong',
                            target: 'Doel',
                            fields: 'Velden',
                            farm: 'Farm',
                            goTo: 'Ga naar'
                        },
                        messages: {
                            villageChanged: 'Succesvol van dorp veranderd!',
                            villageError: 'Alle farms voor het huidige dorp zijn reeds verstuurd!',
                            sendError: 'Error: farm niet verstuurd!'
                        }
                    },
                    int: {
                        missingFeatures: 'Script requires a premium account and loot assistent!',
                        options: {
                            title: 'FarmBeast Options',
                            warning: '<b>Warning:</b><br>- Make sure A is set as your default microfarm and B as a larger microfarm<br>- Make sure the farm filters are set correctly before using the script',
                            filterImage: 'https://higamy.github.io/TW/Scripts/Assets/farmGodFilters.png',
                            group: 'Send farms from group:',
                            distance: 'Maximum fields for farms:',
                            time: 'How much time in minutes should there be between farms:',
                            losses: 'Send farm to villages with partial losses:',
                            maxloot: 'Send a B farm if the last loot was full:',
                            newbarbs: 'Add new barbs te farm:',
                            button: 'Plan farms'
                        },
                        table: {
                            noFarmsPlanned: 'No farms can be sent with the specified settings.',
                            origin: 'Origin',
                            target: 'Target',
                            fields: 'fields',
                            farm: 'Farm',
                            goTo: 'Go to'
                        },
                        messages: {
                            villageChanged: 'Successfully changed village!',
                            villageError: 'All farms for the current village have been sent!',
                            sendError: 'Error: farm not send!'
                        }
                    }
                };

                function get() {
                    return msg[game_data.locale] || msg.int;
                }

                return { get: get };
            })();

            // ============================================================
            //  MAIN MODULE
            // ============================================================
            window.FarmBeast.Main = (function(lib, t) {
                var curVillage = null;
                var farmBusy = false;
                var unitSpeedsPromise = null;

                // ---------- Initialization ----------
                function init() {
                    if (!game_data.features.Premium.active || !game_data.features.FarmAssistent.active) {
                        UI.ErrorMessage(t.missingFeatures);
                        return;
                    }

                    if (game_data.screen !== 'am_farm') {
                        location.href = game_data.link_base_pure + 'am_farm';
                        return;
                    }

                    unitSpeedsPromise = lib.fetchUnitSpeeds();

                    buildOptions().then(function(html) {
                        Dialog.show('FarmBeast', html);
                        $('.optionButton').off('click').on('click', onOptionsConfirm);
                        document.querySelector('.optionButton') && document.querySelector('.optionButton').focus();
                    }).fail(function(err) {
                        console.error('FarmBeast: Failed to build options', err);
                    });
                }

                // ---------- Event Handlers ----------
                function bindEventHandlers() {
                    $('.farmBeast_icon').off('click').on('click', function() {
                        if (game_data.market !== 'nl' || $(this).data('origin') == curVillage) {
                            sendFarm($(this));
                        } else {
                            UI.ErrorMessage(t.messages.villageError);
                        }
                    });

                    $(document).off('keydown.farmbeast').on('keydown.farmbeast', function(e) {
                        if (e.which === 13) {
                            $('.farmBeast_icon').first().trigger('click');
                        }
                    });

                    $('.switchVillage').off('click').on('click', function() {
                        curVillage = $(this).data('id');
                        UI.SuccessMessage(t.messages.villageChanged);
                        $(this).closest('tr').remove();
                    });
                }

                function onOptionsConfirm() {
                    var options = {
                        group: parseInt($('.optionGroup').val(), 10),
                        distance: parseFloat($('.optionDistance').val()),
                        time: parseFloat($('.optionTime').val()),
                        losses: $('.optionLosses').prop('checked'),
                        maxloot: $('.optionMaxloot').prop('checked'),
                        newbarbs: $('.optionNewbarbs').prop('checked') || false
                    };
                    localStorage.setItem('farmBeast_options', JSON.stringify(options));

                    $('.optionsContent').html(UI.Throbber[0].outerHTML + '<br><br>');
                    getData(options).then(function(data) {
                        Dialog.close();
                        var plan = createPlanning(options, data);
                        $('.farmBeastContent').remove();
                        $('#am_widget_Farm').first().before(buildTable(plan.farms));
                        bindEventHandlers();
                        UI.InitProgressBars();
                        UI.updateProgressBar($('#FarmBeastProgressbar'), 0, plan.counter);
                        $('#FarmBeastProgressbar').data({ current: 0, max: plan.counter });
                    }).fail(function(err) {
                        console.error('FarmBeast: Data gathering failed', err);
                        UI.ErrorMessage('Data gathering failed. Check console.');
                    });
                }

                // ---------- Options Dialog ----------
                function buildOptions() {
                    var stored = JSON.parse(localStorage.getItem('farmBeast_options')) || {
                        optionGroup: 0,
                        optionDistance: 25,
                        optionTime: 10,
                        optionLosses: false,
                        optionMaxloot: true,
                        optionNewbarbs: true
                    };
                    var checkboxSettings = [false, true, true, true, false];
                    var checkboxError = $('#plunder_list_filters').find('input[type="checkbox"]')
                        .map(function(i, el) { return $(el).prop('checked') !== checkboxSettings[i]; })
                        .get().indexOf(true) !== -1;

                    var $templateRows = $('form[action*="action=edit_all"]').find('input[type="hidden"][name*="template"]').closest('tr');
                    var templateError = parseFloat($templateRows.first().find('td').last().text()) >=
                                        parseFloat($templateRows.last().find('td').last().text());

                    return buildGroupSelect(stored.optionGroup).then(function(groupSelect) {
                        return '<style>#popup_box_FarmBeast{text-align:center;width:550px;}</style>' +
                            '<h3>' + t.options.title + '</h3><br><div class="optionsContent">' +
                            (checkboxError || templateError ? '<div class="info_box" style="line-height:15px;font-size:10px;text-align:left;"><p style="margin:0 5px;">' + t.options.warning + '<br><img src="' + t.options.filterImage + '" style="width:100%;"></p></div><br>' : '') +
                            '<div style="width:90%;margin:auto;background:url(\'graphic/index/main_bg.jpg\') 100% 0% #E3D5B3;border:1px solid #7D510F;border-collapse:separate;border-spacing:0;"><table class="vis" style="width:100%;text-align:left;font-size:11px;">' +
                            '<tr><td>' + t.options.group + '</td><td>' + groupSelect + '</td></tr>' +
                            '<tr><td>' + t.options.distance + '</td><td><input type="text" size="5" class="optionDistance" value="' + stored.optionDistance + '"></td></tr>' +
                            '<tr><td>' + t.options.time + '</td><td><input type="text" size="5" class="optionTime" value="' + stored.optionTime + '"></td></tr>' +
                            '<tr><td>' + t.options.losses + '</td><td><input type="checkbox" class="optionLosses" ' + (stored.optionLosses ? 'checked' : '') + '></td></tr>' +
                            '<tr><td>' + t.options.maxloot + '</td><td><input type="checkbox" class="optionMaxloot" ' + (stored.optionMaxloot ? 'checked' : '') + '></td></tr>' +
                            (game_data.market === 'nl' ? '<tr><td>' + t.options.newbarbs + '</td><td><input type="checkbox" class="optionNewbarbs" ' + (stored.optionNewbarbs ? 'checked' : '') + '></td></tr>' : '') +
                            '</table></div><br><input type="button" class="btn optionButton" value="' + t.options.button + '"></div>';
                    });
                }

                function buildGroupSelect(selectedId) {
                    return $.get(TribalWars.buildURL('GET', 'groups', { ajax: 'load_group_menu' })).then(function(groups) {
                        var html = '<select class="optionGroup">';
                        groups.result.forEach(function(val) {
                            if (val.type === 'separator') {
                                html += '<option disabled/>';
                            } else {
                                html += '<option value="' + val.group_id + '" ' + (val.group_id == selectedId ? 'selected' : '') + '>' + val.name + '</option>';
                            }
                        });
                        html += '</select>';
                        return html;
                    });
                }

                // ---------- Build Result Table ----------
                function buildTable(plan) {
                    var html = '<div class="vis farmBeastContent"><h4>FarmBeast</h4><table class="vis" width="100%">' +
                        '<tr><div id="FarmBeastProgressbar" class="progress-bar live-progress-bar progress-bar-alive" style="width:98%;margin:5px auto;"><div style="background: rgb(146, 194, 0);"></div><span class="label" style="margin-top:0;"></span></div></tr>' +
                        '<tr><th style="text-align:center;">' + t.table.origin + '</th><th style="text-align:center;">' + t.table.target + '</th><th style="text-align:center;">' + t.table.fields + '</th><th style="text-align:center;">' + t.table.farm + '</th></tr>';

                    if (!$.isEmptyObject(plan)) {
                        for (var originCoord in plan) {
                            if (plan.hasOwnProperty(originCoord)) {
                                if (game_data.market === 'nl') {
                                    var first = plan[originCoord][0];
                                    html += '<tr><td colspan="4" style="background:#e7d098;"><input type="button" class="btn switchVillage" data-id="' + first.origin.id + '" value="' + t.table.goTo + ' ' + first.origin.name + ' (' + first.origin.coord + ')" style="float:right;"></td></tr>';
                                }
                                plan[originCoord].forEach(function(val, i) {
                                    html += '<tr class="farmRow row_' + (i % 2 ? 'b' : 'a') + '">' +
                                        '<td style="text-align:center;"><a href="' + game_data.link_base_pure + 'info_village&id=' + val.origin.id + '">' + val.origin.name + ' (' + val.origin.coord + ')</a></td>' +
                                        '<td style="text-align:center;"><a href="' + game_data.link_base_pure + 'info_village&id=' + val.target.id + '">' + val.target.coord + '</a></td>' +
                                        '<td style="text-align:center;">' + val.fields.toFixed(2) + '</td>' +
                                        '<td style="text-align:center;"><a href="#" data-origin="' + val.origin.id + '" data-target="' + val.target.id + '" data-template="' + val.template.id + '" class="farmBeast_icon farm_icon farm_icon_' + val.template.name + '" style="margin:auto;"></a></td>' +
                                        '</tr>';
                                });
                            }
                        }
                    } else {
                        html += '<tr><td colspan="4" style="text-align:center;">' + t.table.noFarmsPlanned + '</td></tr>';
                    }
                    html += '</table></div>';
                    return html;
                }

                // ---------- Data Gathering ----------
                function getData(options) {
                    var data = {
                        villages: {},
                        commands: {},   // coord -> lastArrival (seconds)
                        farms: { templates: {}, farms: {} }
                    };
                    var skipUnits = ['ram', 'catapult', 'knight', 'snob', 'militia'];

                    return unitSpeedsPromise.then(function() {
                        var unitSpeeds = lib.getUnitSpeeds();

                        function villagesProcessor($html) {
                            var mobile = $('#mobileHeader').length > 0;
                            if (mobile) {
                                $html.find('.overview-container > div').each(function() {
                                    try {
                                        var $el = $(this);
                                        var villageId = $el.find('.quickedit-vn').data('id');
                                        var name = $el.find('.quickedit-label').attr('data-text');
                                        var coord = lib.extractCoord($el.find('.quickedit-label').text());
                                        if (!coord) return;

                                        var units = new Array(game_data.units.length).fill(0);
                                        $el.find('.overview-units-row > div.unit-row-item').each(function() {
                                            var img = $(this).find('img');
                                            var span = $(this).find('span.unit-row-name');
                                            if (img.length && span.length) {
                                                var unitType = img.attr('src').split('unit_')[1].replace(/@2x\.webp|\.webp|\.png/g, '');
                                                var value = parseInt(span.text(), 10) || 0;
                                                var idx = game_data.units.indexOf(unitType);
                                                if (idx !== -1) units[idx] = value;
                                            }
                                        });
                                        var filtered = units.filter(function(_, idx) {
                                            return skipUnits.indexOf(game_data.units[idx]) === -1;
                                        });
                                        data.villages[coord] = { name: name, id: villageId, units: filtered };
                                    } catch (e) {}
                                });
                            } else {
                                $html.find('#combined_table .row_a, #combined_table .row_b').filter(function() {
                                    return $(this).find('.bonus_icon_33').length === 0;
                                }).each(function() {
                                    var $el = $(this);
                                    var $label = $el.find('.quickedit-label').first();
                                    var coord = lib.extractCoord($label.text());
                                    if (!coord) return;

                                    var units = $el.find('.unit-item').map(function(idx, elem) {
                                        if (skipUnits.indexOf(game_data.units[idx]) !== -1) return null;
                                        return parseFloat($(elem).text()) || 0;
                                    }).get().filter(function(v) { return v !== null; });

                                    data.villages[coord] = {
                                        name: $label.data('text'),
                                        id: parseInt($el.find('.quickedit-vn').first().data('id'), 10),
                                        units: units
                                    };
                                });
                            }
                            return data;
                        }

                        function commandsProcessor($html) {
                            $html.find('#commands_table .row_a, #commands_table .row_ax, #commands_table .row_b, #commands_table .row_bx').each(function() {
                                var $el = $(this);
                                var coord = lib.extractCoord($el.find('.quickedit-label').first().text());
                                if (!coord) return;
                                var arrival = Math.round(lib.timestampFromString($el.find('td').eq(2).text().trim()) / 1000);
                                if (!data.commands[coord] || arrival > data.commands[coord]) {
                                    data.commands[coord] = arrival;
                                }
                            });
                            return data;
                        }

                        function farmProcessor($html) {
                            if ($.isEmptyObject(data.farms.templates)) {
                                $html.find('form[action*="action=edit_all"]').find('input[type="hidden"][name*="template"]').closest('tr').each(function() {
                                    var $el = $(this);
                                    var match = $el.prev('tr').find('a.farm_icon').first().attr('class').match(/farm_icon_(.*)\s/);
                                    if (!match) return;
                                    var templateName = match[1];
                                    var templateId = parseFloat($el.find('input[type="hidden"][name*="[id]"]').first().val());
                                    var unitInputs = $el.find('input[type="text"], input[type="number"]');
                                    var units = unitInputs.map(function() { return parseFloat($(this).val()) || 0; }).get();
                                    var speed = Math.max.apply(null, unitInputs.map(function() {
                                        var val = parseFloat($(this).val()) || 0;
                                        if (val === 0) return 0;
                                        var unitName = $(this).attr('name').trim().split('[')[0];
                                        return unitSpeeds[unitName] || 0;
                                    }).get());
                                    data.farms.templates[templateName] = { id: templateId, units: units, speed: speed };
                                });
                            }

                            $html.find('#plunder_list tr[id^="village_"]').each(function() {
                                var $el = $(this);
                                var coord = lib.extractCoord($el.find('a[href*="screen=report&mode=all&view="]').first().text());
                                if (!coord) return;

                                var dotImg = $el.find('img[src*="graphic/dots/"]').attr('src');
                                var colorMatch = dotImg ? dotImg.match(/dots\/(green|yellow|red|blue|red_blue)/) : null;
                                var color = colorMatch ? colorMatch[1] : 'green';
                                var maxLoot = $el.find('img[src*="max_loot/1"]').length > 0;

                                data.farms.farms[coord] = {
                                    id: parseFloat($el.attr('id').split('_')[1]),
                                    color: color,
                                    max_loot: maxLoot
                                };
                            });
                            return data;
                        }

                        function fetchNewBarbs() {
                            if (!options.newbarbs) return Promise.resolve(data);
                            return twLib.get('/map/village.txt').then(function(response) {
                                response.match(/[^\r\n]+/g).forEach(function(line) {
                                    var parts = line.split(',');
                                    if (parts[4] === '0') {
                                        var coord = parts[2] + '|' + parts[3];
                                        if (!data.farms.farms[coord]) {
                                            data.farms.farms[coord] = { id: parseFloat(parts[0]) };
                                        }
                                    }
                                });
                                return data;
                            });
                        }

                        function filterFarms() {
                            data.farms.farms = Object.fromEntries(
                                Object.entries(data.farms.farms).filter(function(entry) {
                                    var val = entry[1];
                                    if (!val.hasOwnProperty('color')) return true;
                                    return val.color !== 'red' && val.color !== 'red_blue' && (val.color !== 'yellow' || options.losses);
                                })
                            );
                            return data;
                        }

                        return Promise.all([
                            lib.processAllPages(TribalWars.buildURL('GET', 'overview_villages', { mode: 'combined', group: options.group }), villagesProcessor),
                            lib.processAllPages(TribalWars.buildURL('GET', 'overview_villages', { mode: 'commands', type: 'attack' }), commandsProcessor),
                            lib.processAllPages(TribalWars.buildURL('GET', 'am_farm'), farmProcessor)
                        ]).then(function() {
                            return fetchNewBarbs();
                        }).then(filterFarms).then(function() {
                            return data;
                        });
                    });
                }

                // ---------- Planning ----------
                function createPlanning(options, data) {
                    var plan = { counter: 0, farms: {} };
                    var serverTime = Math.round(lib.getCurrentServerTime() / 1000);
                    var maxDist = options.distance;
                    var minInterval = options.time * 60;

                    lib.clearDistanceCache();

                    for (var originCoord in data.villages) {
                        if (!data.villages.hasOwnProperty(originCoord)) continue;
                        var originVillage = data.villages[originCoord];
                        var availableUnits = originVillage.units.slice();

                        var candidateTargets = Object.keys(data.farms.farms)
                            .map(function(targetCoord) {
                                if (!lib.isWithinBoundingBox(originCoord, targetCoord, maxDist)) return null;
                                var dist = lib.getDistance(originCoord, targetCoord);
                                if (dist > maxDist) return null;
                                return { coord: targetCoord, dist: dist };
                            })
                            .filter(function(v) { return v !== null; })
                            .sort(function(a, b) { return a.dist - b.dist; });

                        for (var i = 0; i < candidateTargets.length; i++) {
                            var target = candidateTargets[i];
                            var farmInfo = data.farms.farms[target.coord];
                            var templateName = (options.maxloot && farmInfo.max_loot) ? 'b' : 'a';
                            var template = data.farms.templates[templateName];
                            if (!template) continue;

                            var unitsAfter = lib.subtractArrays(availableUnits, template.units);
                            if (!unitsAfter) continue;

                            var travelTime = Math.round(target.dist * template.speed * 60);
                            var candidateArrival = serverTime + travelTime + Math.round(plan.counter / 5);
                            var lastArrival = data.commands[target.coord] || 0;
                            if (Math.abs(candidateArrival - lastArrival) < minInterval) continue;

                            plan.counter++;
                            if (!plan.farms[originCoord]) plan.farms[originCoord] = [];

                            plan.farms[originCoord].push({
                                origin: { coord: originCoord, name: originVillage.name, id: originVillage.id },
                                target: { coord: target.coord, id: farmInfo.id },
                                fields: target.dist,
                                template: { name: templateName, id: template.id }
                            });

                            availableUnits = unitsAfter;
                            data.commands[target.coord] = candidateArrival;
                        }
                    }
                    return plan;
                }

                // ---------- Send Farm ----------
                function sendFarm($this) {
                    var now = Timing.getElapsedTimeSinceLoad();
                    if (farmBusy || (Accountmanager.farm.last_click && now - Accountmanager.farm.last_click < 200)) return;

                    farmBusy = true;
                    Accountmanager.farm.last_click = now;
                    var $pb = $('#FarmBeastProgressbar');

                    var url = Accountmanager.send_units_link.replace(/village=(\d+)/, 'village=' + $this.data('origin'));
                    TribalWars.post(url, null, {
                        target: $this.data('target'),
                        template_id: $this.data('template'),
                        source: $this.data('origin')
                    }, function(response) {
                        UI.SuccessMessage(response.success);
                        $pb.data('current', $pb.data('current') + 1);
                        UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
                        $this.closest('.farmRow').remove();
                        farmBusy = false;
                    }, function(error) {
                        UI.ErrorMessage(error || t.messages.sendError);
                        $pb.data('current', $pb.data('current') + 1);
                        UI.updateProgressBar($pb, $pb.data('current'), $pb.data('max'));
                        $this.closest('.farmRow').remove();
                        farmBusy = false;
                    });
                }

                return { init: init };
            })(window.FarmBeast.Library, window.FarmBeast.Translation.get());

            // ----- Start the script -----
            window.FarmBeast.Main.init();
            console.log('FarmBeast: Initialization complete.');

        } catch (e) {
            console.error('FarmBeast: Fatal error during initialization:', e);
            alert('FarmBeast Error: ' + e.message);
        }
    });
})();
