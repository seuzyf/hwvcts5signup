const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    try {
        const payload = JSON.parse(event.body);
        
        // 核心修改：优先使用 SERVICE_ROLE_KEY。它具有超级管理员权限，可以安全地在后端绕过 RLS 策略
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);
        
        // 1. 先查询数据库中是否已经存在该姓名的选手
        const { data: existingData } = await supabase
            .from('player_stats')
            .select('player_name')
            .eq('player_name', payload.player_name)
            .maybeSingle();
            
        // 2. 更新或插入当前报名玩家的数据
        if (existingData) {
            // 使用 select() 强制返回更新后的结果，用于拦截静默失败
            const { data: updatedData, error } = await supabase
                .from('player_stats')
                .update(payload)
                .eq('player_name', payload.player_name)
                .select();
                
            if (error) throw error;
            if (!updatedData || updatedData.length === 0) {
                throw new Error('更新失败：请确保 Netlify 环境变量中已正确配置 SUPABASE_SERVICE_ROLE_KEY');
            }
        } else {
            const { error } = await supabase
                .from('player_stats')
                .insert([payload]);
            if (error) throw error;
        }
        
        // 3. 拉取全服所有玩家的数据，重新计算所有人的排名和分组
        const { data: allPlayers, error: fetchError } = await supabase
            .from('player_stats')
            .select('player_name, hw_score, pre_group');
            
        if (fetchError) throw fetchError;

        // 按照华为分降序排列
        allPlayers.sort((a, b) => b.hw_score - a.hw_score);

        const totalPlayers = allPlayers.length;
        const legendCount = Math.ceil(totalPlayers * 0.30);
        const middleCount = Math.ceil(totalPlayers * 0.60);

        // 收集需要更新分组的玩家请求
        const updatePromises = [];

        allPlayers.forEach((player, index) => {
            const rank = index + 1;
            let newGroup = '挑战组';
            
            // 计算这个玩家现在应该属于哪个组
            if (rank <= legendCount) {
                newGroup = '传奇组';
            } else if (rank <= middleCount) {
                newGroup = '中间组';
            }

            // 如果该玩家现在应该在的组和数据库里存的不一致，需要刷新他
            if (player.pre_group !== newGroup) {
                updatePromises.push(
                    supabase
                        .from('player_stats')
                        .update({ pre_group: newGroup })
                        .eq('player_name', player.player_name)
                );
            }
        });

        // 4. 并发执行所有需要刷新的更新操作
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }
        
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};